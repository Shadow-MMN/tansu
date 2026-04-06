/**
 * Cloudflare Worker for delegated dual-provider IPFS uploads.
 *
 * The dapp sends a signed message authorizing the expected CID plus the CAR
 * content to upload. The worker verifies the signature before uploading to
 * Filebase and Pinata in parallel.
 */

import { Keypair } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";

export interface Env {
  FILEBASE_TOKEN: string;
  PINATA_JWT: string;
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

function validateUploadRequest(body: UploadRequest): void {
  const { cid, message, signature, signerAddress, car } = body;

  if (!cid || !message || !signature || !signerAddress || !car) {
    throw new Error(
      "Missing required fields: cid, message, signature, signerAddress and car",
    );
  }

  if (!message.includes(`CID: ${cid}`)) {
    throw new Error("Signed message does not contain the expected CID");
  }

  const verified = Keypair.fromPublicKey(signerAddress).verify(
    Buffer.from(new TextEncoder().encode(message)),
    Buffer.from(decodeBase64(signature)),
  );

  if (!verified) {
    throw new Error("Message signature is invalid for the signer address");
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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

    // ---------- FILEBASE ----------
    async function uploadToFilebase() {
      try {
        const res = await fetch("https://api.filebase.io/v1/ipfs/car", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.FILEBASE_TOKEN}`,
          },
          body: carBlob,
        });

        if (!res.ok) {
          return { ok: false, error: `HTTP ${res.status}` };
        }

        const data: any = await res.json();
        const cid = data.cid || data.CID;

        if (cid && cid !== body.cid) {
          return { ok: false, error: "CID mismatch" };
        }

        return { ok: true };
      } catch (e: any) {
        return { ok: false, error: e.message };
      }
    }

    // ---------- PINATA ----------
    async function uploadToPinata(retries = 1): Promise<any> {
      const formData = new FormData();
      formData.append("file", carBlob, `${body.cid}.car`);

      try {
        const res = await fetch(
          "https://api.pinata.cloud/pinning/pinFileToIPFS",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${env.PINATA_JWT}`,
            },
            body: formData,
          },
        );

        if (!res.ok) {
          if (retries > 0) return uploadToPinata(retries - 1);
          return { ok: false, error: `HTTP ${res.status}` };
        }

        const data: any = await res.json();
        if (data.IpfsHash && data.IpfsHash !== body.cid) {
          return { ok: false, error: "CID mismatch" };
        }

        return { ok: true };
      } catch (e: any) {
        if (retries > 0) return uploadToPinata(retries - 1);
        return { ok: false, error: e.message };
      }
    }

    // Run both
    const [filebase, pinata] = await Promise.all([
      uploadToFilebase(),
      uploadToPinata(),
    ]);

    const success = filebase.ok || pinata.ok;

    return new Response(
      JSON.stringify({
        success,
        filebase: filebase.ok,
        pinata: pinata.ok,
        message: success
          ? undefined
          : `Filebase: ${filebase.error} | Pinata: ${pinata.error}`,
        error: success
          ? undefined
          : `Filebase: ${filebase.error} | Pinata: ${pinata.error}`,
        cid: body.cid,
      }),
      {
        status: success ? 200 : 502,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      },
    );
  },
};
