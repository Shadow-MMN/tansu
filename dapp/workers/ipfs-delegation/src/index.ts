export interface Env {
  FILEBASE_TOKEN: string;
  PINATA_JWT: string;
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
    "Access-Control-Allow-Headers": "Content-Type, x-expected-cid",
    "Access-Control-Max-Age": "86400",
  };
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

    const expectedCid = request.headers.get("x-expected-cid");
    if (!expectedCid) {
      return new Response(
        JSON.stringify({ success: false, error: "Missing x-expected-cid" }),
        {
          status: 400,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    let carBlob: Blob;
    try {
      carBlob = await request.blob();
      if (carBlob.size === 0) throw new Error();
    } catch {
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

        if (cid && cid !== expectedCid) {
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
      formData.append("file", carBlob, `${expectedCid}.car`);

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
        if (data.IpfsHash && data.IpfsHash !== expectedCid) {
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
        error: success
          ? undefined
          : `Filebase: ${filebase.error} | Pinata: ${pinata.error}`,
        cid: expectedCid,
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
