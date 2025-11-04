try { if (process.env.DEBUG_QUAL) { console.log("[qual][props]", JSON.stringify(props, null, 2)); } await hsFetch(url, { method: "PATCH", body: JSON.stringify({ properties: props })
