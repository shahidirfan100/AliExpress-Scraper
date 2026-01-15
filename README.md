# 🛒 AliExpress Product Scraper

Extract comprehensive product data from AliExpress search results. Get detailed information including prices, ratings, seller details, and images for market research, price monitoring, and competitive analysis.

## What Data Can You Extract?

This scraper collects the following product information from AliExpress:

| Field | Description |
|-------|-------------|
| **Product ID** | Unique AliExpress product identifier |
| **Title** | Full product name and description |
| **Price** | Current sale price |
| **Original Price** | Price before discount |
| **Currency** | Currency code (USD, EUR, etc.) |
| **Rating** | Average star rating (1-5) |
| **Reviews Count** | Total number of customer reviews |
| **Orders** | Number of items sold |
| **Store Name** | Seller's store name |
| **Store URL** | Link to the seller's store |
| **Image URL** | Main product image |
| **Product URL** | Direct link to product page |

## How to Use

### Basic Usage

Search for products using a keyword:

```json
{
  "keyword": "wireless earbuds",
  "results_wanted": 50
}
```

### Advanced Filtering

Apply price filters and sorting:

```json
{
  "keyword": "phone case",
  "minPrice": 5,
  "maxPrice": 20,
  "sortBy": "orders",
  "results_wanted": 100
}
```

### Direct URL Input

Start from a specific AliExpress search URL:

```json
{
  "startUrl": "https://www.aliexpress.com/w/wholesale-laptop-stand.html",
  "results_wanted": 30
}
```

## Input Configuration

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `keyword` | String | No | `"Towel"` | Product search term |
| `startUrl` | String | No | - | Direct AliExpress search URL |
| `category` | String | No | - | Category filter |
| `minPrice` | Number | No | - | Minimum price filter |
| `maxPrice` | Number | No | - | Maximum price filter |
| `sortBy` | Enum | No | `"default"` | Sort order: `default`, `price_asc`, `price_desc`, `orders` |
| `results_wanted` | Integer | No | `20` | Maximum products to collect |
| `proxyConfiguration` | Object | No | Residential | Proxy settings |

## Sample Output

```json
{
  "product_id": "1005006447212156",
  "title": "Wireless Bluetooth Earbuds TWS Headphones",
  "price": "$12.99",
  "original_price": "$25.99",
  "currency": "USD",
  "rating": "4.7",
  "reviews_count": 1250,
  "orders": 5000,
  "store_name": "Tech Store Official",
  "store_url": "https://www.aliexpress.com/store/1102142044",
  "image_url": "https://ae01.alicdn.com/kf/product-image.jpg",
  "product_url": "https://www.aliexpress.com/item/1005006447212156.html"
}
```

## Tips for Best Results

### Recommended Proxy Settings

For optimal performance, use residential proxies:

```json
{
  "proxyConfiguration": {
    "useApifyProxy": true,
    "apifyProxyGroups": ["RESIDENTIAL"]
  }
}
```

### Performance Optimization

- Start with smaller `results_wanted` values (20-50) for testing
- Use specific keywords for more relevant results
- Apply price filters to narrow down the search
- Sort by `orders` to find popular products

## Use Cases

### Market Research
Analyze product trends, pricing strategies, and popular categories across the AliExpress marketplace.

### Price Monitoring
Track competitor pricing and discount patterns for informed business decisions.

### Dropshipping Research
Find reliable suppliers by analyzing store ratings, order counts, and customer reviews.

### Product Sourcing
Discover new product opportunities by exploring top-selling items in any category.

### Competitive Analysis
Compare product offerings, pricing, and seller ratings across similar items.

## Cost Estimation

The scraper uses browser automation for reliable data extraction. Estimated costs:

| Products | Approximate Cost |
|----------|------------------|
| 20 | ~$0.10 |
| 100 | ~$0.50 |
| 500 | ~$2.50 |
| 1000 | ~$5.00 |

*Costs may vary based on proxy usage and retry attempts.*

## Frequently Asked Questions

### How often is the data updated?
Each scrape fetches real-time data directly from AliExpress search results.

### Can I scrape specific categories?
Yes, use the `category` parameter or include the category in your search URL.

### What if I get blocked?
The scraper includes built-in stealth measures. For best results, use residential proxies and reasonable request intervals.

### How many products can I scrape?
There's no hard limit, but AliExpress search results are typically limited to 60 pages per query. Use different keywords or filters to expand your dataset.

### Can I get product reviews?
This scraper focuses on search results data. For detailed reviews, consider visiting individual product pages.

## Integrations

Export your data in multiple formats:

- **JSON** - For programmatic access
- **CSV** - For spreadsheet analysis
- **Excel** - For business reporting
- **API** - Direct integration with your systems

Connect with your favorite tools through Apify integrations including Google Sheets, Airtable, Zapier, Make, and more.

## Support

- View the [Apify documentation](https://docs.apify.com/) for platform guidance
- Check the [actor's issues page](https://console.apify.com/) for known issues
- Contact support through the Apify Console for assistance

---

Built for reliable AliExpress data extraction with enterprise-grade infrastructure.
