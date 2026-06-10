try {
  await import("bun:sqlite");
  console.log("bun:sqlite imported!");
} catch (e) {
  console.log("bun:sqlite could not be imported:", e.message);
}
