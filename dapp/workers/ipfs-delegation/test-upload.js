#!/usr/bin/env node
import "dotenv/config";
import { Keypair } from "@stellar/stellar-sdk";
import { createDirectoryEncoderStream, CAREncoderStream } from "ipfs-car";

const DEV_URL = "https://ipfs-testnet.tansu.dev";
const PROD_URL = "https://ipfs.tansu.dev";
const ENV = process.env.ENV || "LOCAL";

let WORKER_URL = "http://localhost:8787";
if (ENV === "DEV") {
  WORKER_URL = DEV_URL;
} else if (ENV === "PROD") {
  WORKER_URL = PROD_URL;
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

async function packFilesToCar(files) {
  const stream = createDirectoryEncoderStream(files);
  const carEncoder = new CAREncoderStream();
  let rootCID;

  const captureRoot = new TransformStream({
    transform(block, controller) {
      if (!rootCID) rootCID = block.cid.toString();
      controller.enqueue(block);
    },
  });

  const chunks = [];
  const collectStream = new WritableStream({
    write(chunk) {
      chunks.push(chunk);
    },
  });

  await stream
    .pipeThrough(captureRoot)
    .pipeThrough(carEncoder)
    .pipeTo(collectStream);

  if (!rootCID) {
    throw new Error("Failed to compute test CID");
  }

  return {
    cid: rootCID,
    car: new Blob(chunks, { type: "application/vnd.ipld.car" }),
  };
}

async function test() {
  console.log(`Connecting to worker at: ${WORKER_URL}`);

  const testFile = new File(
    ["This is a test file uploaded via the IPFS delegation worker!"],
    "test.txt",
    { type: "text/plain" },
  );
  const { cid, car } = await packFilesToCar([testFile]);

  const signer = process.env.TEST_SIGNER_SECRET
    ? Keypair.fromSecret(process.env.TEST_SIGNER_SECRET)
    : Keypair.random();
  const message = `Tansu IPFS upload authorization\nCID: ${cid}`;
  const signature = signer.sign(new TextEncoder().encode(message));

  try {
    const res = await fetch(WORKER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        cid,
        message,
        signature: arrayBufferToBase64(signature),
        signerAddress: signer.publicKey(),
        car: arrayBufferToBase64(await car.arrayBuffer()),
      }),
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

    console.log("\n✅ Upload request completed successfully!");
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
