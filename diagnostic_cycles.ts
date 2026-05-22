
import { createDatabase } from "./src/infra/db/connection.ts";
import { buildGraph } from "./src/services/strategy/graph.ts";
import { enumerateCycles } from "./src/services/strategy/finder.ts";
import path from "path";

const db = createDatabase("data/registry.db");
const rows = db.prepare("SELECT address, protocol, tokens FROM pools WHERE status = 'active'").all() as any[];
const pools = rows.map(r => ({
  address: r.address,
  protocol: r.protocol,
  tokens: JSON.parse(r.tokens)
}));

console.log(`Pools: ${pools.length}`);
const startTime = Date.now();
const graph = buildGraph(pools, new Map());
console.log(`Graph built in ${Date.now() - startTime}ms`);

const cycles2 = enumerateCycles(graph, 2);
console.log(`2-hop cycles: ${cycles2.length} in ${Date.now() - startTime}ms`);

const cycles3 = enumerateCycles(graph, 3);
console.log(`3-hop cycles: ${cycles3.length} in ${Date.now() - startTime}ms`);

const cycles4 = enumerateCycles(graph, 4);
console.log(`4-hop cycles: ${cycles4.length} in ${Date.now() - startTime}ms`);
