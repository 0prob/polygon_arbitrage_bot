const { HypersyncClient } = require("@envio-dev/hypersync-client");

async function main() {
    const client = new HypersyncClient({
        url: "https://polygon.hypersync.xyz",
        apiToken: "Bearer test_token_123",
        httpReqTimeoutMillis: 1000
    });
    console.log(client);
    
    try {
        await client.getHeight();
    } catch(e) {
        console.error(e);
    }
}
main();
