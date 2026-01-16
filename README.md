# AliExpress Product Scraper

Scrape AliExpress product listings at scale. Extract prices, ratings, reviews, seller information, and more from the world's largest online marketplace. Perfect for market research, price monitoring, competitor analysis, and dropshipping product sourcing.

## Features

- **Keyword Search** — Search products using any keyword or phrase
- **Direct URL Support** — Start from any AliExpress search results page
- **Price Filtering** — Filter by minimum and maximum price range
- **Sorting Options** — Sort by price, orders, or relevance
- **Seller Information** — Get store names and direct store URLs
- **Product Ratings** — Extract star ratings and review counts
- **Sales Data** — See how many orders each product has received
- **High Volume** — Collect hundreds or thousands of products per run

## Use Cases

### E-commerce Research
Discover trending products and analyze pricing strategies across categories. Identify best-selling items and understand market demand patterns.

### Price Monitoring
Track competitor pricing in real-time. Monitor price fluctuations and discount patterns to optimize your own pricing strategy.

### Dropshipping & Sourcing
Find reliable suppliers by analyzing store ratings, order volumes, and customer reviews. Compare similar products across multiple sellers.

### Competitive Analysis
Benchmark your products against competitors. Analyze pricing, ratings, and sales performance across the marketplace.

### Lead Generation
Build targeted lists of suppliers and sellers for outreach campaigns. Filter by product category, price range, or sales volume.

---

## Input Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `keyword` | String | No | `"Towel"` | Search term to find products |
| `startUrl` | String | No | — | Direct AliExpress search page URL |
| `category` | String | No | — | Category ID to filter results |
| `minPrice` | Number | No | — | Minimum product price |
| `maxPrice` | Number | No | — | Maximum product price |
| `sortBy` | String | No | `"default"` | Sort order: `default`, `price_asc`, `price_desc`, `orders` |
| `results_wanted` | Integer | No | `20` | Maximum number of products to collect |
| `proxyConfiguration` | Object | No | Residential | Proxy settings for requests |

---

## Output Data

Each product in the dataset contains the following fields:

| Field | Type | Description |
|-------|------|-------------|
| `product_id` | String | Unique AliExpress product identifier |
| `title` | String | Full product title and description |
| `price` | String | Current sale price with currency symbol |
| `original_price` | String | Original price before discount |
| `currency` | String | Currency code (USD, EUR, etc.) |
| `rating` | Number | Average star rating (1.0 - 5.0) |
| `reviews_count` | Number | Total number of customer reviews |
| `orders` | Number | Number of items sold |
| `store_name` | String | Name of the seller's store |
| `store_url` | String | Direct URL to the seller's store page |
| `image_url` | String | Main product image URL |
| `product_url` | String | Direct link to product detail page |

---

## Usage Examples

### Basic Keyword Search

Search for products using a simple keyword:

```json
{
    "keyword": "wireless earbuds",
    "results_wanted": 50
}
```

### Price Range Filter

Find products within a specific price range:

```json
{
    "keyword": "phone case",
    "minPrice": 5,
    "maxPrice": 25,
    "results_wanted": 100
}
```

### Sort by Best Sellers

Get the most popular products sorted by order count:

```json
{
    "keyword": "laptop stand",
    "sortBy": "orders",
    "results_wanted": 200
}
```

### Direct URL Input

Start from a specific search results page:

```json
{
    "startUrl": "https://www.aliexpress.com/w/wholesale-bluetooth-speaker.html",
    "results_wanted": 150
}
```

### Price Ascending Search

Find the cheapest products first:

```json
{
    "keyword": "USB cable",
    "sortBy": "price_asc",
    "maxPrice": 10,
    "results_wanted": 50
}
```

---

## Sample Output

```json
{
    "product_id": "1005006447212156",
    "title": "Wireless Bluetooth Earbuds TWS Headphones Stereo Sound",
    "price": "$12.99",
    "original_price": "$25.99",
    "currency": "USD",
    "rating": 4.7,
    "reviews_count": 2847,
    "orders": 15420,
    "store_name": "TechGadgets Official Store",
    "store_url": "https://www.aliexpress.com/store/1102142044",
    "image_url": "https://ae01.alicdn.com/kf/S1234567890abcdef.jpg",
    "product_url": "https://www.aliexpress.com/item/1005006447212156.html"
}
```

---

## Tips for Best Results

### Optimize Your Search Keywords
- Use specific, descriptive keywords for more relevant results
- Include product type, brand names, or key features
- Try variations of your search term to capture more products

### Use Price Filters Effectively
- Set realistic price ranges based on your target market
- Combine price filters with sorting for better results
- Use `price_asc` sorting to find budget-friendly options

### Maximize Data Quality
- Start with smaller batches (20-50) for testing
- Use `orders` sorting to prioritize proven products
- Filter by category when available for focused results

### Proxy Configuration
For optimal performance, residential proxies are recommended:

```json
{
    "proxyConfiguration": {
        "useApifyProxy": true,
        "apifyProxyGroups": ["RESIDENTIAL"]
    }
}
```

---

## Integrations

Connect your scraped data with popular tools and platforms:

- **Google Sheets** — Automatically sync products to spreadsheets
- **Airtable** — Build product databases and catalogs
- **Zapier** — Trigger workflows based on new products
- **Make (Integromat)** — Create automated data pipelines
- **Webhooks** — Send data to your custom endpoints
- **Slack** — Get notifications for new products
- **Email** — Receive automated reports

### Export Formats

Download your data in multiple formats:

- **JSON** — For developers and API integrations
- **CSV** — For spreadsheet analysis and Excel
- **Excel** — For business reporting and presentations
- **XML** — For legacy system integrations

---

## Important Data Notes

> [!NOTE]
> **AliExpress "Choice" Items**: The majority of products in AliExpress search results are now "Choice" items. These products are fulfilled through AliExpress's multi-seller network rather than individual stores. As a result, **store_name** and **reviews_count** fields are not available for Choice items in search result data—this is an AliExpress platform limitation, not a scraper limitation.

**What data is always available:**
- Product ID, title, price, original price, currency
- Product image and URL
- Star rating (1-5)
- Orders/sold count

**What data may be missing for Choice items:**
- Store name (fulfilled by AliExpress network)
- Review count (not exposed in search results)
- Store URL (no single store for Choice items)

**Full data available for:**
- Sponsored/advertised products
- Regular third-party seller listings
- Non-Choice marketplace items

---

## Frequently Asked Questions

### How many products can I scrape?
You can collect thousands of products per run. The practical limit depends on your search query and AliExpress search results availability (typically up to 60 pages per query).

### How often is the data updated?
Each run fetches real-time data directly from AliExpress. Schedule regular runs to keep your data fresh.

### Can I search specific categories?
Yes, use the `category` parameter with a category ID, or include category filters in your `startUrl`.

### What if some fields are empty?
Product listings vary in completeness. Some sellers may not display all information. The scraper extracts all available data for each product.

### How do I get more products?
Use different keyword variations, remove price filters, or set a higher `results_wanted` value. You can also run multiple searches with different parameters.

### Can I scrape product reviews?
This scraper focuses on search results data. For detailed product reviews, use dedicated review scraping solutions.

---

## Support & Resources

- **[Apify Documentation](https://docs.apify.com/)** — Platform guides and tutorials
- **[Apify Console](https://console.apify.com/)** — Manage runs and view results
- **[API Reference](https://docs.apify.com/api/v2)** — Programmatic access documentation

For issues or feature requests, contact support through the Apify Console.

---

## Legal & Compliance

This actor is designed for legitimate data collection purposes. Users are responsible for ensuring their use complies with AliExpress terms of service and applicable laws. Always respect rate limits and use data responsibly.
