// AliExpress Product Scraper - PlaywrightCrawler with Camoufox stealth
import { PlaywrightCrawler, Dataset } from '@crawlee/playwright';
import { Actor, log } from 'apify';
import { launchOptions as camoufoxLaunchOptions } from 'camoufox-js';
import { firefox } from 'playwright';

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

// Extract price value
const extractPrice = (priceData) => {
    if (!priceData) return null;
    if (typeof priceData === 'string') {
        const match = priceData.match(/[\d,.]+/);
        return match ? priceData : null;
    }
    if (priceData.formattedPrice) return priceData.formattedPrice;
    if (priceData.minPrice) return priceData.minPrice;
    return null;
};

// Extract products from page JSON data
const extractProductsFromJson = (pageData) => {
    const products = [];

    try {
        // Try various data paths
        const itemList =
            pageData?.data?.root?.fields?.mods?.itemList?.content ||
            pageData?.data?.data?.root?.fields?.mods?.itemList?.content ||
            pageData?.mods?.itemList?.content ||
            pageData?.itemList?.content ||
            pageData?.data?.content ||
            pageData?.content ||
            [];

        for (const item of itemList) {
            const product = {
                product_id: item.productId || item.itemId || item.id || null,
                title: item.title?.displayTitle || item.title?.seoTitle || item.title || null,
                price: extractPrice(item.prices?.salePrice) || item.price || null,
                original_price: extractPrice(item.prices?.originalPrice) || item.oriPrice || null,
                currency: item.prices?.currencyCode || 'USD',
                rating: item.evaluation?.starRating || item.starRating || item.averageStar || null,
                reviews_count: item.evaluation?.totalCount || item.reviewCount || null,
                orders: parseSoldCount(item.trade?.tradeDesc) || item.soldCount || parseSoldCount(item.sold) || null,
                store_name: item.store?.storeName || item.storeName || null,
                store_url: item.store?.storeUrl ? (item.store.storeUrl.startsWith('//') ? `https:${item.store.storeUrl}` : item.store.storeUrl) : null,
                image_url: normalizeImageUrl(item.image?.imgUrl || item.imageUrl || item.img),
                product_url: item.productDetailUrl ? (item.productDetailUrl.startsWith('//') ? `https:${item.productDetailUrl}` : item.productDetailUrl) : (item.productId ? `https://www.aliexpress.com/item/${item.productId}.html` : null),
            };

            if (product.product_id && product.title) {
                products.push(product);
            }
        }
    } catch (err) {
        log.debug(`JSON extraction error: ${err.message}`);
    }

    return products;
};

// Create proxy configuration for getting proxy URL
// IMPORTANT: We only use this to get proxy URLs for Camoufox, NOT for PlaywrightCrawler
const proxyConfiguration = await Actor.createProxyConfiguration(proxyConfig || {
    useApifyProxy: true,
    apifyProxyGroups: ['RESIDENTIAL'],
});

let saved = 0;
const seenIds = new Set();
const initial = startUrl ? [{ url: startUrl, userData: { pageNo: 1 } }] : [{ url: buildSearchUrl(keyword, 1), userData: { pageNo: 1 } }];

// Get proxy URL for Camoufox - this is the ONLY place proxy is used
const proxyUrl = await proxyConfiguration.newUrl();
log.info(`Using proxy: ${proxyUrl ? proxyUrl.replace(/:[^:@]+@/, ':***@') : 'none'}`);

// Get Camoufox launch options with proxy configured at browser level
const camoufoxOptions = await camoufoxLaunchOptions({
    headless: true,
    proxy: proxyUrl, // Proxy is handled by Camoufox at browser level
    geoip: true,
});

const crawler = new PlaywrightCrawler({
    // DO NOT pass proxyConfiguration here - Camoufox handles proxy at browser level
    // This prevents double-proxying conflicts
    maxRequestRetries: 3,
    useSessionPool: true,
    sessionPoolOptions: {
        maxPoolSize: 10,
        sessionOptions: {
            maxUsageCount: 5,
        },
    },
    maxConcurrency: 3,
    requestHandlerTimeoutSecs: 120,
    navigationTimeoutSecs: 60,
    launchContext: {
        launcher: firefox,
        launchOptions: camoufoxOptions,
    },
    preNavigationHooks: [
        async ({ page }, gotoOptions) => {
            gotoOptions.waitUntil = 'domcontentloaded';

            // Set realistic viewport
            await page.setViewportSize({
                width: 1366 + Math.floor(Math.random() * 200),
                height: 768 + Math.floor(Math.random() * 200),
            });

            // Block unnecessary resources for speed
            await page.route('**/*', (route) => {
                const resourceType = route.request().resourceType();
                const url = route.request().url();

                if (['media', 'font'].includes(resourceType)) {
                    return route.abort();
                }
                if (url.includes('google-analytics') || url.includes('facebook') ||
                    url.includes('doubleclick') || url.includes('hotjar') ||
                    url.includes('beacon') || url.includes('tracking')) {
                    return route.abort();
                }
                return route.continue();
            });

            // Set extra headers
            await page.setExtraHTTPHeaders({
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Sec-Fetch-User': '?1',
                'Cache-Control': 'max-age=0',
            });
        },
    ],
    async requestHandler({ page, request, crawler: crawlerInstance }) {
        const pageNo = request.userData?.pageNo || 1;
        log.info(`Processing page ${pageNo}: ${request.url}`);

        // Wait for page load
        await page.waitForLoadState('domcontentloaded');

        // Random delay for human-like behavior
        await page.waitForTimeout(2000 + Math.random() * 2000);

        // Wait for content to load
        try {
            await page.waitForSelector('[class*="CardWrapper"], [class*="product-card"], [class*="search-item-card"], .search-card-item', { timeout: 30000 });
        } catch (e) {
            log.warning(`Could not find product cards, trying alternative approach...`);
        }

        // Scroll to load lazy content
        await page.evaluate(async () => {
            for (let i = 0; i < 3; i++) {
                window.scrollBy(0, window.innerHeight);
                await new Promise(r => setTimeout(r, 500));
            }
            window.scrollTo(0, 0);
        });

        await page.waitForTimeout(1000);

        let products = [];

        // Try to extract from embedded JSON first
        try {
            const jsonData = await page.evaluate(() => {
                // Try window._dida_config_
                if (window._dida_config_?.data) return window._dida_config_;

                // Try window.runParams
                if (window.runParams?.data) return window.runParams;

                // Try __INITIAL_STATE__
                if (window.__INITIAL_STATE__) return window.__INITIAL_STATE__;

                // Try to find in script tags
                const scripts = document.querySelectorAll('script');
                for (const script of scripts) {
                    const text = script.textContent || '';

                    // Look for _dida_config_
                    let match = text.match(/window\._dida_config_\s*=\s*(\{[\s\S]*?\});/);
                    if (match) {
                        try { return JSON.parse(match[1]); } catch { }
                    }

                    // Look for runParams
                    match = text.match(/window\.runParams\s*=\s*(\{[\s\S]*?\});/);
                    if (match) {
                        try { return JSON.parse(match[1]); } catch { }
                    }

                    // Look for itemList in any format
                    if (text.includes('"itemList"') && text.includes('"content"')) {
                        match = text.match(/\{[\s\S]*"itemList"[\s\S]*"content"[\s\S]*\}/);
                        if (match) {
                            try { return JSON.parse(match[0]); } catch { }
                        }
                    }
                }
                return null;
            });

            if (jsonData) {
                log.info('Found embedded JSON data, extracting products...');
                products = extractProductsFromJson(jsonData);
                log.info(`Extracted ${products.length} products from JSON`);
            }
        } catch (err) {
            log.debug(`JSON extraction failed: ${err.message}`);
        }

        // Fallback to HTML parsing
        if (products.length === 0) {
            log.info('Falling back to HTML parsing...');
            try {
                products = await page.$$eval('[class*="CardWrapper"], [class*="product-card"], [class*="search-item-card"], .search-card-item, [data-widget="item"]', (cards) => {
                    return cards.map(card => {
                        const getTextContent = (selectors) => {
                            for (const sel of selectors) {
                                const el = card.querySelector(sel);
                                if (el?.textContent?.trim()) return el.textContent.trim();
                            }
                            return null;
                        };

                        const getAttr = (selectors, attr) => {
                            for (const sel of selectors) {
                                const el = card.querySelector(sel);
                                if (el?.getAttribute(attr)) return el.getAttribute(attr);
                            }
                            return null;
                        };

                        const link = card.querySelector('a[href*="/item/"]');
                        const productUrl = link?.href || null;
                        const productIdMatch = productUrl?.match(/\/item\/(\d+)\.html/);
                        const productId = productIdMatch ? productIdMatch[1] : null;

                        const priceText = getTextContent(['[class*="price"] span', '[class*="Price"]', '.price']);
                        const originalPriceText = getTextContent(['[class*="origin"] span', '[class*="OriginalPrice"]', '.ori-price']);

                        const ratingText = getTextContent(['[class*="rating"]', '[class*="star"]']);
                        const ratingMatch = ratingText?.match(/([\d.]+)/);

                        const soldText = getTextContent(['[class*="sold"]', '[class*="trade"]', '[class*="orders"]']);
                        const soldMatch = soldText?.match(/([\d,]+)/);

                        const imgSrc = getAttr(['img[src*="alicdn"]', 'img[data-src]', 'img'], 'src') ||
                            getAttr(['img[data-src]'], 'data-src');

                        return {
                            product_id: productId,
                            title: getTextContent(['h1', 'h3', '[class*="title"]', '[class*="Title"]', '.title']),
                            price: priceText,
                            original_price: originalPriceText,
                            currency: 'USD',
                            rating: ratingMatch ? ratingMatch[1] : null,
                            reviews_count: null,
                            orders: soldMatch ? parseInt(soldMatch[1].replace(/,/g, ''), 10) : null,
                            store_name: getTextContent(['[class*="store"]', '[class*="Store"]', '.store-name']),
                            store_url: getAttr(['a[href*="/store/"]'], 'href'),
                            image_url: imgSrc?.startsWith('//') ? `https:${imgSrc}` : imgSrc,
                            product_url: productUrl,
                        };
                    }).filter(p => p.product_id && p.title);
                });
                log.info(`Extracted ${products.length} products from HTML`);
            } catch (err) {
                log.error(`HTML extraction failed: ${err.message}`);
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
