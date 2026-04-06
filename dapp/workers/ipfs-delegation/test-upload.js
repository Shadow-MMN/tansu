#!/usr/bin/env node
import "dotenv/config";

/**
 * IPFS Proxy Test Script
 *
 * Sends a CAR-like blob to the IPFS proxy worker
 * and validates the dual-provider response (Filebase + Pinata).
 */

const WORKER_URL =
  process.env.PUBLIC_DELEGATION_API_URL ||
  "https://ipfs-proxy.shadow-ipfs-proxy.workers.dev";

// Example CAR-like content (replace with real CAR when ready)
const carContent = new Blob(["Hello from IPFS proxy test"], {
  type: "application/vnd.ipld.car",
});

// Fake CID to match the test content
const fakeCid = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

async function test() {
  console.log(`\n🔹 Testing IPFS proxy at: ${WORKER_URL}`);

  try {
    const res = await fetch(WORKER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/vnd.ipld.car",
        "x-expected-cid": fakeCid,
      },
      body: carContent,
    });

    let data;
    try {
      data = await res.json();
    } catch {
      data = null;
    }

    console.log("\n📊 Status:", res.status);
    console.log("📄 Response:", JSON.stringify(data, null, 2));

    if (!res.ok) {
      throw new Error(`Worker returned HTTP status ${res.status}`);
    }

    if (!data?.success) {
      throw new Error(
        `Upload failed. Proxy reported failure: ${JSON.stringify(data)}`,
      );
    }

    console.log("\n✅ Proxy request completed successfully!");
    console.log("🔑 CID returned by proxy:", data.cid);
    console.log(
      "✅ Filebase success:",
      data.filebase,
      "| ✅ Pinata success:",
      data.pinata,
    );

    if (!data.filebase || !data.pinata) {
      console.warn(
        "⚠️ One of the providers failed. Check logs and provider status.",
      );
    }
  } catch (err) {
    console.error("\n❌ Test failed:", err);
    process.exit(1);
  }
}

test();
