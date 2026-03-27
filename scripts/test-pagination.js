const mimovrste = require('../server/utils/mimovrste-campaign');

async function test() {
    const campaignId = 'odprta-embalaza';
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
    const referer = 'https://www.mimovrste.com/kampanja/odprta-embalaza';
    
    console.log(`Testing campaign: ${campaignId}`);
    
    // Test the new paginated fetch
    const items = await mimovrste.fetchMimovrsteCampaignItems(campaignId, null, UA, referer);
    console.log(`\n✅ Finished fetch: Found ${items.length} total items.`);
    
    if (items.length > 0) {
        console.log('Sample item:', JSON.stringify(items[0], null, 2));
        const mapped = mimovrste.mapGqlItemsToProducts(items, 'https://www.mimovrste.com');
        console.log(`Mapped ${mapped.length} products.`);
    }
}

test();
