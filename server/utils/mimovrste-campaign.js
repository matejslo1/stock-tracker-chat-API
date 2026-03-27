const http = require('./http');

/**
 * Shared logic for scraping Mimovrste campaign pages using GraphQL.
 */

const GQL = `query($c: String!, $cat: String) {
  getCampaign(campaignId: $c, query: { isMobile: false, previewHash: "", abTestVariant: "", bannersPage: "" }) {
    productCollection(query: { categoryUrlKey: $cat }) {
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
 * Fetch campaign items via GraphQL
 */
async function fetchMimovrsteCampaignItems(campaignId, categoryUrlKey, userAgent, referer) {
  try {
    const res = await http.post('https://www.mimovrste.com/web-gateway/graphql', {
      query: GQL,
      variables: { c: campaignId, cat: categoryUrlKey || null },
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://www.mimovrste.com',
        'Referer': referer,
        'User-Agent': userAgent,
      },
      timeout: 15000, validateStatus: () => true,
    });
    
    return res.data?.data?.getCampaign?.productCollection?.items || [];
  } catch(e) {
    console.error('  Mimovrste GQL Fetch Error:', e.message);
    return [];
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
