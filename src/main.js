// AliExpress Product Scraper - CheerioCrawler for cost-effective scraping
import { CheerioCrawler, Dataset } from 'crawlee';
import { Actor, log } from 'apify';
import { load as cheerioLoad } from 'cheerio';

// Initialize Apify SDK
await Actor.init();

const input = (await Actor.getInput()) || {};
const {
    keyword = 'Towel',
    startUrl,
    category,
    minPrice,
    maxPrice,
    sortBy = 'default',
    results_wanted: RESULTS_WANTED_RAW = 20,
    proxyConfiguration: proxyConfig,
} = input;

const RESULTS_WANTED = Number.isFinite(+RESULTS_WANTED_RAW) ? Math.max(1, +RESULTS_WANTED_RAW) : 20;

log.info(`Starting AliExpress scraper for keyword: "${keyword}", results wanted: ${RESULTS_WANTED}`);

// Build search URL
const buildSearchUrl = (kw, page = 1) => {
    const encodedKeyword = encodeURIComponent(kw.trim().replace(/\s+/g, '-'));
    const u = new URL(`https://www.aliexpress.com/w/wholesale-${encodedKeyword}.html`);

    if (page > 1) u.searchParams.set('page', String(page));

    if (sortBy === 'price_asc') u.searchParams.set('SortType', 'price_asc');
    else if (sortBy === 'price_desc') u.searchParams.set('SortType', 'price_desc');
    else if (sortBy === 'orders') u.searchParams.set('SortType', 'total_tranpro_desc');

    if (minPrice) u.searchParams.set('minPrice', String(minPrice));
    if (maxPrice) u.searchParams.set('maxPrice', String(maxPrice));
    if (category) u.searchParams.set('CatId', String(category));

    return u.href;
};

// Normalize image URL
const normalizeImageUrl = (url) => {
    if (!url) return null;
    let cleanUrl = url.startsWith('//') ? `https:${url}` : url;
    cleanUrl = cleanUrl.split('?')[0].split('_')[0];
    if (!cleanUrl.match(/\.(jpg|jpeg|png|webp|gif)$/i)) {
        cleanUrl = cleanUrl + '.jpg';
    }
    return cleanUrl;
};

// Parse sold/orders count
const parseSoldCount = (text) => {
    if (!text) return null;
    const match = text.match(/([\d,.]+)\+?\s*(sold|orders|pcs)?/i);
    if (match) {
        return parseInt(match[1].replace(/[,.\s]/g, ''), 10) || null;
    }
    return null;
};

// Extract price value and currency
const extractPrice = (priceData) => {
    if (!priceData) return { amount: null, currency: 'USD' };

    let priceStr = null;
    if (typeof priceData === 'string') {
        priceStr = priceData;
    } else if (priceData.formattedPrice) {
        priceStr = priceData.formattedPrice;
    } else if (priceData.minPrice) {
        priceStr = String(priceData.minPrice);
    }

    if (!priceStr) return { amount: null, currency: 'USD' };

    // Extract currency symbol
    const currencyMatch = priceStr.match(/[$€£¥₹]/);
    const currency = currencyMatch ?
        ({ '$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR' }[currencyMatch[0]] || 'USD') :
        'USD';

    return { amount: priceStr, currency };
};

// Extract products from page JSON data - FIX for actual AliExpress structure
const extractProductsFromJson = (pageData) => {
    const products = [];

    try {
        // AliExpress uses different nested structures
        let itemList = [];

        // Try different paths based on actual AliExpress JSON structure
        if (pageData?.data?.root?.fields?.mods?.itemList?.content) {
            itemList = pageData.data.root.fields.mods.itemList.content;
        } else if (pageData?.data?.itemList?.content) {
            itemList = pageData.data.itemList.content;
        } else if (pageData?.mods?.itemList?.content) {
            itemList = pageData.mods.itemList.content;
        } else if (pageData?.itemList?.content) {
            itemList = pageData.itemList.content;
        } else if (Array.isArray(pageData?.content)) {
            itemList = pageData.content;
        } else if (Array.isArray(pageData?.data)) {
            itemList = pageData.data;
        }

        log.debug(`Found ${itemList.length} items in JSON`);

        for (const item of itemList) {
            // Skip if not a product item
            if (!item || item.itemType !== 'productV3') continue;

            const priceInfo = extractPrice(item.prices?.salePrice || item.price);
            const originalPriceInfo = extractPrice(item.prices?.originalPrice || item.oriPrice);

            const product = {
                product_id: String(item.productId || item.itemId || item.id || ''),
                title: item.title?.displayTitle || item.title?.seoTitle || item.title || null,
                price: priceInfo.amount,
                original_price: originalPriceInfo.amount,
                currency: priceInfo.currency,
                rating: item.evaluation?.starRating || item.starRating || item.averageStar || null,
                reviews_count: item.evaluation?.totalCount || item.evaluation?.reviewCount || item.reviewCount || null,
                orders: parseSoldCount(item.trade?.tradeDesc) || item.soldCount || parseSoldCount(item.sold) || null,
                store_name: item.store?.storeName || item.storeName || null,
                store_url: item.store?.storeUrl ?
                    (item.store.storeUrl.startsWith('//') ? `https:${item.store.storeUrl}` : item.store.storeUrl) :
                    (item.store?.storeId ? `https://www.aliexpress.com/store/${item.store.storeId}` : null),
                image_url: normalizeImageUrl(item.image?.imgUrl || item.imageUrl || item.img),
                product_url: item.productDetailUrl ?
                    (item.productDetailUrl.startsWith('//') ? `https:${item.productDetailUrl}` : item.productDetailUrl) :
                    (item.productId ? `https://www.aliexpress.com/item/${item.productId}.html` : null),
            };

            if (product.product_id && product.title) {
                products.push(product);
            }
        }
    } catch (err) {
        log.error(`JSON extraction error: ${err.message}`);
    }

    return products;
};

// Extract products from HTML with improved selectors
const extractProductsFromHtml = ($) => {
    const products = [];

    try {
        // Find all product cards
        const cards = $(
            '[class*="search-card-item"], ' +
            '[class*="list--gallery--"], ' +
            '[data-widget="item"], ' +
            '.product-item, ' +
            '[class*="CardWrapper"]'
        ).toArray();

        log.debug(`Found ${cards.length} product cards in HTML`);

        for (const card of cards) {
            const $card = $(card);

            // Extract link and ID
            const $link = $card.find('a[href*="/item/"], a[href*="aliexpress.com"]').first();
            const productUrl = $link.attr('href') || null;
            const productIdMatch = productUrl?.match(/\/item\/(\d+)\.html/);
            const productId = productIdMatch ? productIdMatch[1] : null;

            if (!productId) continue;

            // Extract title
            const title =
                $card.find('[class*="title"], h1, h2, h3').first().text().trim() ||
                $link.attr('title') ||
                null;

            // Extract prices with better selectors
            const priceText =
                $card.find('[class*="price--current"], [class*="Price--"], [class*="snow-price"]').first().text().trim() ||
                $card.find('[class*="price"] span, .price').first().text().trim() ||
                null;

            const originalPriceText =
                $card.find('[class*="price--original"], [class*="OriginalPrice"]').first().text().trim() ||
                $card.find('[class*="origin"]').first().text().trim() ||
                null;

            // Extract rating
            const ratingText = $card.find('[class*="rating"], [class*="star"]').first().text().trim();
            const ratingMatch = ratingText?.match(/([\d.]+)/);

            // Extract reviews count
            const reviewText = $card.find('[class*="review"]').first().text().trim();
            const reviewMatch = reviewText?.match(/([\d,]+)/);

            // Extract orders/sold
            const soldText = $card.find('[class*="sold"], [class*="trade"], [class*="order"]').first().text().trim();

            // Extract store
            const storeName = $card.find('[class*="store"], [class*="Shop"]').first().text().trim() || null;
            const storeUrl = $card.find('a[href*="/store/"]').first().attr('href') || null;

            // Extract image
            const imgSrc =
                $card.find('img[src*="alicdn"]').first().attr('src') ||
                $card.find('img[data-src]').first().attr('data-src') ||
                $card.find('img').first().attr('src') ||
                null;

            const product = {
                product_id: productId,
                title,
                price: priceText,
                original_price: originalPriceText,
                currency: 'USD',
                rating: ratingMatch ? ratingMatch[1] : null,
                reviews_count: reviewMatch ? parseInt(reviewMatch[1].replace(/,/g, ''), 10) : null,
                orders: parseSoldCount(soldText),
                store_name: storeName,
                store_url: storeUrl ? (storeUrl.startsWith('//') ? `https:${storeUrl}` : storeUrl) : null,
                image_url: imgSrc ? normalizeImageUrl(imgSrc) : null,
                product_url: productUrl ? (productUrl.startsWith('//') ? `https:${productUrl}` : productUrl) : null,
            };

            if (product.product_id && product.title) {
                products.push(product);
            }
        }
    } catch (err) {
        log.error(`HTML extraction error: ${err.message}`);
    }

    return products;
};

// Create proxy configuration
const proxyConfiguration = await Actor.createProxyConfiguration(proxyConfig || {
    useApifyProxy: true,
    apifyProxyGroups: ['RESIDENTIAL'],
});

let saved = 0;
const seenIds = new Set();
const initial = startUrl ? [{ url: startUrl, userData: { pageNo: 1 } }] : [{ url: buildSearchUrl(keyword, 1), userData: { pageNo: 1 } }];

const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxRequestRetries: 3,
    useSessionPool: true,
    sessionPoolOptions: {
        maxPoolSize: 10,
        sessionOptions: {
            maxUsageCount: 10,
        },
    },
    maxConcurrency: 5,
    requestHandlerTimeoutSecs: 60,
    // Add stealth headers to avoid blocking
    preNavigationHooks: [
        async ({ request }) => {
            request.headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Sec-Fetch-User': '?1',
                'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
                'Sec-Ch-Ua-Mobile': '?0',
                'Sec-Ch-Ua-Platform': '"Windows"',
                'Cache-Control': 'max-age=0',
            };
        },
    ],
    async requestHandler({ $, request, crawler: crawlerInstance, body }) {
        const pageNo = request.userData?.pageNo || 1;
        log.info(`Processing page ${pageNo}: ${request.url}`);

        let products = [];
        const htmlContent = body.toString();

        // Log HTML size for debugging
        log.debug(`Received HTML: ${htmlContent.length} bytes`);

        // Check if we're being blocked
        if (htmlContent.includes('/_____tmd_____/punish') ||
            htmlContent.includes('x5sec') ||
            htmlContent.includes('captcha') ||
            htmlContent.length < 10000) {
            log.warning(`Possible blocking detected. HTML length: ${htmlContent.length}`);
        }

        // Try to extract from embedded JSON first - IMPROVED EXTRACTION
        try {
            // Look for window._dida_config_
            let match = htmlContent.match(/window\._dida_config_\s*=\s*({[\s\S]*?});/);

            if (!match) {
                // Look for window.runParams
                match = htmlContent.match(/window\.runParams\s*=\s*({[\s\S]*?});/);
            }

            if (!match) {
                // Look for __INITIAL_STATE__
                match = htmlContent.match(/__INITIAL_STATE__\s*=\s*({[\s\S]*?});/);
            }

            if (match) {
                try {
                    const jsonData = JSON.parse(match[1]);
                    log.info('Found embedded JSON data, extracting products...');
                    products = extractProductsFromJson(jsonData);
                    log.info(`Extracted ${products.length} products from JSON`);
                } catch (parseErr) {
                    log.warning(`Failed to parse JSON: ${parseErr.message}`);
                }
            } else {
                log.warning('No JSON data found in page');
            }
        } catch (err) {
            log.debug(`JSON extraction failed: ${err.message}`);
        }

        // Fallback to HTML parsing if JSON fails
        if (products.length === 0) {
            log.info('Falling back to HTML parsing...');
            products = extractProductsFromHtml($);
            log.info(`Extracted ${products.length} products from HTML`);

            // Debug: log the first few product card structures
            if (products.length === 0) {
                const cardCount = $(
                    '[class*="search-card-item"], ' +
                    '[class*="list--gallery--"], ' +
                    '[data-widget="item"], ' +
                    '.product-item, ' +
                    '[class*="CardWrapper"]'
                ).length;
                log.warning(`Found ${cardCount} potential product cards but extracted 0 products`);

                // Log sample HTML structure for debugging
                const sampleCard = $(
                    '[class*="search-card-item"], ' +
                    '[class*="list--gallery--"]'
                ).first();
                if (sampleCard.length) {
                    log.debug(`Sample card classes: ${sampleCard.attr('class')}`);
                }
            }
        }

        // Save products
        const newProducts = [];
        for (const product of products) {
            if (saved >= RESULTS_WANTED) break;

            const id = product.product_id;
            if (id && !seenIds.has(id)) {
                seenIds.add(id);
                newProducts.push(product);
                saved++;
            }
        }

        if (newProducts.length > 0) {
            await Dataset.pushData(newProducts);
            log.info(`Saved ${newProducts.length} new products. Total: ${saved}/${RESULTS_WANTED}`);
        }

        // Pagination
        if (saved < RESULTS_WANTED && products.length > 0) {
            const nextPage = pageNo + 1;
            const nextUrl = buildSearchUrl(keyword, nextPage);

            log.info(`Enqueueing page ${nextPage}...`);
            await crawlerInstance.addRequests([{
                url: nextUrl,
                userData: { pageNo: nextPage },
            }]);
        }
    },

    failedRequestHandler({ request }, error) {
        log.error(`Request ${request.url} failed: ${error.message}`);
    },
});

await crawler.run(initial);

log.info(`Scraping completed. Total products saved: ${saved}`);

// Exit successfully
await Actor.exit();
