const { HypersyncClient } = require("@envio-dev/hypersync-client");

async function main() {
    const token = "a3cbea70-ad7d-4308-a4be-b14e095ce169";
    const client1 = new HypersyncClient({
        url: "https://polygon.hypersync.xyz",
        apiToken: "Bearer " + token,
        httpReqTimeoutMillis: 5000
    });
    
    try {
        console.log("Trying with Bearer prefix...");
        const height = await client1.getHeight();
        console.log("Success with Bearer prefix! Height:", height);
    } catch(e) {
        console.error("Failed with Bearer prefix");
    }

    const client2 = new HypersyncClient({
        url: "https://polygon.hypersync.xyz",
        apiToken: token,
        httpReqTimeoutMillis: 5000
    });

    try {
        console.log("Trying without Bearer prefix...");
        const height = await client2.getHeight();
        console.log("Success without Bearer prefix! Height:", height);
    } catch(e) {
        console.error("Failed without Bearer prefix");
    }
}
main();
