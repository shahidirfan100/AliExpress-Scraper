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

// Extract products from page JSON data - FIXED with recursive search
const extractProductsFromJson = (pageData) => {
    const products = [];

    try {
        // Helper: Recursively find array of products
        const findProductArray = (obj, depth = 0, path = '') => {
            if (depth > 7 || !obj) return null;

            // Check if this is a product array
            if (Array.isArray(obj) && obj.length > 0) {
                // Verify it contains product objects
                const firstItem = obj[0];
                if (firstItem && (firstItem.productId || firstItem.itemId || firstItem.id)) {
                    log.info(`Found product array at depth ${depth}, path: ${path}, count: ${obj.length}`);
                    return obj;
                }
            }

            // Recursively check object properties
            if (typeof obj === 'object' && obj !== null) {
                for (const key in obj) {
                    const result = findProductArray(obj[key], depth + 1, path ? `${path}.${key}` : key);
                    if (result) return result;
                }
            }
            return null;
        };

        const itemList = findProductArray(pageData);

        if (!itemList) {
            log.warning('Could not find product array in JSON structure');
            log.debug(`JSON keys at root: ${Object.keys(pageData).join(', ')}`);
            return [];
        }

        log.info(`Processing ${itemList.length} items from JSON`);

        for (const item of itemList) {
            // Skip if not a valid product
            if (!item) continue;

            // Extract product ID
            const productId = String(item.productId || item.itemId || item.id || '');
            if (!productId) continue;

            // Extract title
            const title =
                item.title?.displayTitle ||
                item.title?.seoTitle ||
                item.title ||
                item.productTitle ||
                item.name ||
                null;

            if (!title) continue; // Skip if no title

            // Extract prices
            const priceInfo = extractPrice(
                item.prices?.salePrice ||
                item.salePrice ||
                item.price ||
                item.prices?.minPrice
            );

            const originalPriceInfo = extractPrice(
                item.prices?.originalPrice ||
                item.oriPrice ||
                item.originalPrice
            );

            // Extract rating
            const rating =
                item.evaluation?.starRating ||
                item.starRating ||
                item.averageStar ||
                item.rating ||
                null;

            // Extract review count
            const reviews_count =
                item.evaluation?.totalCount ||
                item.evaluation?.reviewCount ||
                item.reviewCount ||
                item.reviewsCount ||
                null;

            // Extract orders/sold count
            const orders = parseSoldCount(
                item.trade?.tradeDesc ||
                item.tradeDesc ||
                item.salesCount ||
                item.soldCount ||
                item.sold
            );

            // Extract store info
            const store_name =
                item.store?.storeName ||
                item.storeName ||
                item.shopName ||
                null;

            const store_url = item.store?.storeUrl
                ? (item.store.storeUrl.startsWith('//') ? `https:${item.store.storeUrl}` : item.store.storeUrl)
                : (item.store?.storeId ? `https://www.aliexpress.com/store/${item.store.storeId}` : null);

            // Extract images
            const image_url = normalizeImageUrl(
                item.image?.imgUrl ||
                item.imageUrl ||
                item.img ||
                item.productImage
            );

            // Extract product URL
            const product_url = item.productDetailUrl
                ? (item.productDetailUrl.startsWith('//') ? `https:${item.productDetailUrl}` : item.productDetailUrl)
                : (productId ? `https://www.aliexpress.com/item/${productId}.html` : null);

            const product = {
                product_id: productId,
                title,
                price: priceInfo.amount,
                original_price: originalPriceInfo.amount,
                currency: priceInfo.currency,
                rating,
                reviews_count,
                orders,
                store_name,
                store_url,
                image_url,
                product_url,
            };

            products.push(product);
        }

        log.info(`Successfully extracted ${products.length} products from JSON`);
    } catch (err) {
        log.error(`JSON extraction error: ${err.message}`);
        log.debug(`Error stack: ${err.stack}`);
    }

    return products;
};

// Extract products from HTML with ACTUAL selectors from browser inspection
const extractProductsFromHtml = ($) => {
    const products = [];

    try {
        // Use actual selector from browser inspection
        const cards = $('.search-card-item').toArray();

        log.debug(`Found ${cards.length} product cards in HTML`);

        for (const card of cards) {
            const $card = $(card);

            // Extract link and ID
            const $link = $card.find('a[href*="/item/"]').first();
            let productUrl = $link.attr('href');

            // Try to extract product ID from URL
            let productId = null;
            if (productUrl) {
                const productIdMatch = productUrl.match(/\/item\/(\d+)\.html/);
                productId = productIdMatch ? productIdMatch[1] : null;
            }

            // If no ID found from URL, try data attributes
            if (!productId) {
                productId = $card.attr('data-product-id') || $card.attr('data-id') || null;
            }

            // Skip if still no product ID
            if (!productId) {
                log.debug('Card found but no product ID extracted');
                continue;
            }

            // Construct URL if missing
            if (!productUrl) {
                productUrl = `https://www.aliexpress.com/item/${productId}.html`;
            }

            // Extract title using flexible selector (classes are mangled)
            const title =
                $card.find('div[class*="titleText"]').first().text().trim() ||
                $card.find('div[class*="title"]').first().text().trim() ||
                $card.find('div[class*="Title"]').first().text().trim() ||
                $card.find('a[class*="title"]').first().text().trim() ||
                $card.find('h3, h2, h1').first().text().trim() ||
                $card.find('span[class*="title"]').first().text().trim() ||
                $link.attr('title') ||
                $link.text().trim() ||
                `Product ${productId}`; // Fallback to ID if no title found

            // Extract prices using flexible selectors
            const priceText =
                $card.find('div[class*="price-sale"]').first().text().trim() ||
                $card.find('div[class*="snow-price"]').first().text().trim() ||
                $card.find('div[class*="Price"]').first().text().trim() ||
                $card.find('.price').first().text().trim() ||
                null;

            const originalPriceText =
                $card.find('div[class*="price-original"]').first().text().trim() ||
                $card.find('div[class*="OriginalPrice"]').first().text().trim() ||
                null;

            // Extract rating using aria-label (most reliable)
            const $ratingEl = $card.find('div[aria-label*="rating"]').first();
            let rating = null;
            if ($ratingEl.length) {
                const ariaLabel = $ratingEl.attr('aria-label');
                const ratingMatch = ariaLabel?.match(/([\d.]+)/);
                rating = ratingMatch ? ratingMatch[1] : null;
            }
            // Fallback to class-based selectors
            if (!rating) {
                const ratingText = $card.find('div[class*="rating"], div[class*="star"]').first().text().trim();
                const ratingMatch = ratingText?.match(/([\d.]+)/);
                rating = ratingMatch ? ratingMatch[1] : null;
            }

            // Extract reviews count
            const reviewText = $card.find('span[class*="review"], span[class*="Rating"]').first().text().trim();
            const reviewMatch = reviewText?.match(/([\d,]+)/);
            const reviews_count = reviewMatch ? parseInt(reviewMatch[1].replace(/,/g, ''), 10) : null;

            // Extract orders/sold - look for text like "10,000+ sold"
            const soldText = $card.text(); // Get all text in card
            const soldMatch = soldText.match(/([\d,]+)\+?\s*(sold|orders)/i);
            const orders = soldMatch ? parseInt(soldMatch[1].replace(/,/g, ''), 10) : null;

            // Extract store info
            const store_name =
                $card.find('div[class*="store"], div[class*="Shop"], a[class*="store"]').first().text().trim() ||
                null;

            const store_url = $card.find('a[href*="/store/"]').first().attr('href') || null;

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
                currency: 'USD', // Default, will be extracted from price text if available
                rating,
                reviews_count,
                orders,
                store_name,
                store_url: store_url ? (store_url.startsWith('//') ? `https:${store_url}` : store_url) : null,
                image_url: imgSrc ? normalizeImageUrl(imgSrc) : null,
                product_url: productUrl.startsWith('//') ? `https:${productUrl}` : productUrl,
            };

            products.push(product);
        }

        log.info(`Extracted ${products.length} products from HTML`);
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

        // Try to extract from embedded JSON first - IMPROVED EXTRACTION with DEBUG
        try {
            // Look for window._dida_config_
            let match = htmlContent.match(/window\._dida_config_\s*=\s*({[\s\S]*?});/);
            let varName = '_dida_config_';

            if (!match) {
                // Look for window.runParams
                match = htmlContent.match(/window\.runParams\s*=\s*({[\s\S]*?});/);
                varName = 'runParams';
            }

            if (!match) {
                // Look for __INITIAL_STATE__
                match = htmlContent.match(/__INITIAL_STATE__\s*=\s*({[\s\S]*?});/);
                varName = '__INITIAL_STATE__';
            }

            if (match) {
                try {
                    const jsonData = JSON.parse(match[1]);
                    log.info(`Found embedded JSON data in window.${varName}, extracting products...`);

                    // DEBUG: Log JSON structure
                    const keys = Object.keys(jsonData);
                    log.info(`JSON root keys: ${keys.join(', ')}`);

                    // If data key exists, log its keys too
                    if (jsonData.data) {
                        const dataKeys = Object.keys(jsonData.data);
                        log.info(`JSON data keys (first 10): ${dataKeys.slice(0, 10).join(', ')}`);
                    }

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
