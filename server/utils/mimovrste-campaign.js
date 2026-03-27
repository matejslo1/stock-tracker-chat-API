const http = require('./http');

/**
 * Shared logic for scraping Mimovrste campaign pages using GraphQL.
 */

const GQL = `query getCampaignForList($c: String!, $cat: String, $pagination: ProductCollectionPaginationInput) {
  getCampaign(campaignId: $c, query: { isMobile: false, previewHash: "", abTestVariant: "", bannersPage: "" }) {
    productCollection(query: { categoryUrlKey: $cat, pagination: $pagination }) {
      itemsTotalCount
      items { 
        ... on Product { 
          id 
          title 
          urlKey 
          mainVariant { 
            price 
            priceRrp 
            availability { status } 
            mediaIds
            isAvailable
          } 
        } 
      }
    }
  }
}`;

/**
 * Fetch campaign items via GraphQL with pagination support
 */
async function fetchMimovrsteCampaignItems(campaignId, categoryUrlKey, userAgent, referer) {
  let allItems = [];
  let offset = 0;
  const limit = 40; // Mimovrste usually uses 24, but 40 works too
  let totalCount = 0;

  try {
    do {
      console.log(`  Mimovrste GQL: Fetching ${campaignId} (offset: ${offset})...`);
      const res = await http.post('https://www.mimovrste.com/web-gateway/graphql', {
        query: GQL,
        variables: { 
          c: campaignId, 
          cat: categoryUrlKey || null,
          pagination: { limit, offset }
        },
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Origin': 'https://www.mimovrste.com',
          'Referer': referer,
          'User-Agent': userAgent,
        },
        timeout: 15000, validateStatus: () => true,
      });

      const collection = res.data?.data?.getCampaign?.productCollection;
      const items = collection?.items || [];
      totalCount = collection?.itemsTotalCount || 0;
      
      if (items.length === 0) break;
      
      allItems = allItems.concat(items);
      offset += items.length;

      // Safety break: don't fetch more than 1000 items to avoid timeouts/bans
      if (offset >= 1000 || allItems.length >= totalCount) break;

      // Small delay between pages
      if (offset < totalCount) await new Promise(r => setTimeout(r, 400));

    } while (offset < totalCount);

    return allItems;
  } catch(e) {
    console.error('  Mimovrste GQL Fetch Error:', e.message);
    return allItems; // Return what we got so far
  }
}

/**
 * Map GraphQL items to internal product format
 */
function mapGqlItemsToProducts(items, baseUrl) {
  return items
    .filter(p => p.urlKey && p.title)
    .map(p => {
      const mv = p.mainVariant || {};
      const price = mv.price ? parseFloat(mv.price) : null;
      const imgId = mv.mediaIds && mv.mediaIds.length > 0 ? mv.mediaIds[0] : null;
      return {
        name: p.title,
        url: `${baseUrl}/proizvod/${p.urlKey}`,
        price: price,
        inStock: mv.availability?.status === 'A2' || mv.isAvailable === true ? true : undefined,
        image: imgId ? `https://www.mimovrste.com/i/${imgId}/240/235` : '',
      };
    });
}

function isCampaignUrl(url) {
  return url.includes('mimovrste.com/kampanja/') || url.includes('mimovrste.si/kampanja/');
}

function extractCampaignId(url) {
  try {
    const urlObj = new URL(url);
    const match = urlObj.pathname.match(/\/kampanja\/([^/?#]+)/);
    return match ? match[1] : null;
  } catch(e) { return null; }
}

module.exports = {
  fetchMimovrsteCampaignItems,
  mapGqlItemsToProducts,
  isCampaignUrl,
  extractCampaignId
};
