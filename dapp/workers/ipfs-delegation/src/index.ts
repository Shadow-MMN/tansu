/**
 * Cloudflare Worker for delegated IPFS uploads.
 *
 * The dapp sends a signed message authorizing the expected CID plus the CAR
 * content to upload. The worker verifies the signature, uploads the CAR to
 * Filebase, then pins the resulting CID on Pinata in the background.
 */

import { Keypair } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import { createHash } from "node:crypto";
import { CarReader } from "@ipld/car";

export interface Env {
  FILEBASE_TOKEN: string;
  PINATA_JWT?: string;
  PINATA_GROUP_ID?: string;
  ENABLE_PINATA_PINNING?: string;
}

interface UploadRequest {
  cid: string;
  message: string;
  signature: string;
  signerAddress: string;
  car: string;
}

const ALLOWED_ORIGINS = [
  "http://localhost:4321",
  "https://testnet.tansu.dev",
  "https://app.tansu.dev",
  "https://tansu.xlm.sh",
  "https://deploy-preview-*--staging-tansu.netlify.app",
];
const FILEBASE_MAX_ATTEMPTS = 3;
const PINATA_MAX_ATTEMPTS = 3;

function isPinataEnabled(env: Env): boolean {
  return env.ENABLE_PINATA_PINNING === "true";
}

function getCorsHeaders(origin: string | null): Record<string, string> {
  if (!origin) return {};

  const isAllowed = ALLOWED_ORIGINS.some(
    (allowed) =>
      allowed === origin ||
      (allowed.includes("*") &&
        new RegExp(`^${allowed.replace(/\*/g, ".*")}$`).test(origin)),
  );

  if (!isAllowed) return {};

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function decodeBase64(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

function buildUploadBlob(base64Car: string): Blob {
  return new Blob([decodeBase64(base64Car)], {
    type: "application/vnd.ipld.car",
  });
}

function hashSep53Message(message: string): Buffer {
  return createHash("sha256")
    .update(`Stellar Signed Message:\n${message}`, "utf8")
    .digest();
}

function validateUploadRequest(body: UploadRequest): void {
  const { cid, message, signature, signerAddress, car } = body;

  if (!cid || !message || !signature || !signerAddress || !car) {
    throw new Error(
      "Missing required fields: cid, message, signature, signerAddress and car",
    );
  }

  if (!message.startsWith("CID: ")) {
    throw new Error("Signed message must follow the expected CID format");
  }

  if (!message.includes(`CID: ${cid}`)) {
    throw new Error("Signed message does not contain the expected CID");
  }

  const verified = Keypair.fromPublicKey(signerAddress).verify(
    hashSep53Message(message),
    Buffer.from(decodeBase64(signature)),
  );

  if (!verified) {
    throw new Error("Message signature is invalid for the signer address");
  }
}

async function calculateCidFromCar(carBlob: Blob): Promise<string> {
  const reader = await CarReader.fromBytes(
    new Uint8Array(await carBlob.arrayBuffer()),
  );
  const roots = await reader.getRoots();
  const root = roots[0];

  if (root) {
    return root.toString();
  }

  let lastCid: string | undefined;
  for await (const block of reader.blocks()) {
    lastCid = block.cid.toString();
  }

  if (!lastCid) {
    throw new Error("CAR file does not contain a root CID");
  }

  return lastCid;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withExponentialBackoff<T>(
  operation: () => Promise<T>,
  maxAttempts: number,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts - 1) {
        await sleep(500 * 2 ** attempt);
      }
    }
  }

  throw lastError;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const origin = request.headers.get("Origin");
    const corsHeaders = getCorsHeaders(origin);

    // Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    if (request.method !== "POST") {
      return new Response(
        JSON.stringify({ success: false, error: "Method not allowed" }),
        {
          status: 405,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    let body: UploadRequest;
    try {
      body = (await request.json()) as UploadRequest;
      validateUploadRequest(body);
    } catch (error: any) {
      return new Response(
        JSON.stringify({
          success: false,
          error: error?.message ?? "Invalid upload request",
        }),
        {
          status: 400,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    const carBlob = buildUploadBlob(body.car);
    if (carBlob.size === 0) {
      return new Response(
        JSON.stringify({ success: false, error: "Invalid CAR body" }),
        {
          status: 400,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    let calculatedCid: string;
    try {
      calculatedCid = await calculateCidFromCar(carBlob);
    } catch (error: any) {
      return new Response(
        JSON.stringify({
          success: false,
          error: error?.message ?? "Failed to calculate CID from CAR",
        }),
        {
          status: 400,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    if (calculatedCid !== body.cid) {
      return new Response(
        JSON.stringify({
          success: false,
          error: `CID mismatch: expected ${body.cid}, got ${calculatedCid}`,
        }),
        {
          status: 400,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    async function uploadToFilebase(): Promise<void> {
      await withExponentialBackoff(async () => {
        const formData = new FormData();
        formData.append("file", carBlob, `${body.cid}.car`);

        const res = await fetch("https://rpc.filebase.io/api/v0/dag/import", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.FILEBASE_TOKEN}`,
          },
          body: formData,
        });

        if (!res.ok) {
          throw new Error(`Filebase HTTP ${res.status}`);
        }

        const text = await res.text();
        if (text && !text.includes(body.cid)) {
          throw new Error("Filebase CID mismatch");
        }
      }, FILEBASE_MAX_ATTEMPTS);
    }

    async function pinCidOnPinata(): Promise<void> {
      if (!env.PINATA_JWT) {
        throw new Error("Pinata JWT not configured");
      }

      await withExponentialBackoff(async () => {
        const payload: Record<string, unknown> = {
          cid: body.cid,
          name: `${body.cid}.car`,
        };

        if (env.PINATA_GROUP_ID) {
          payload.group_id = env.PINATA_GROUP_ID;
        }

        const res = await fetch(
          "https://api.pinata.cloud/v3/files/public/pin_by_cid",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${env.PINATA_JWT}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
          },
        );

        if (!res.ok) {
          throw new Error(`Pinata HTTP ${res.status}`);
        }

        const data: any = await res.json();
        const cid = data?.data?.cid;
        if (cid && cid !== body.cid) {
          throw new Error("Pinata CID mismatch");
        }
      }, PINATA_MAX_ATTEMPTS);
    }

    try {
      await uploadToFilebase();
    } catch (error: any) {
      return new Response(
        JSON.stringify({
          success: false,
          error: error?.message ?? "Filebase upload failed",
          cid: body.cid,
        }),
        {
          status: 502,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    if (isPinataEnabled(env)) {
      ctx.waitUntil(
        pinCidOnPinata().catch((error) => {
          console.error("Pinata pin by CID failed:", error);
        }),
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        cid: body.cid,
      }),
      {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      },
    );
  },
};
