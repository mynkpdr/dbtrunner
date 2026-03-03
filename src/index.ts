import { getSandbox, parseSSEStream, type Sandbox } from "@cloudflare/sandbox";
import { Buffer } from "node:buffer";
import { signJWT, verifyJWT } from "./encrypt";

export { Sandbox } from "@cloudflare/sandbox";

type Env = {
  Sandbox: DurableObjectNamespace<Sandbox>;
  JWT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  ALLOWED_EMAIL_DOMAINS?: string; // Comma-separated list of allowed domains
  ALLOWED_EMAILS?: string; // Comma-separated list of specific allowed emails
};

const ALLOWED_EMAIL_DOMAINS = (env: Env) => {
  const domains = env.ALLOWED_EMAIL_DOMAINS?.split(",") || [];
  return domains.map((d) => d.trim());
};
const ALLOWED_EMAILS = (env: Env) => {
  const emails = env.ALLOWED_EMAILS?.split(",") || [];
  return emails.map((e) => e.trim());
};

// --- Utilities ---
const CORS_HEADERS = (request: Request) => {
  const origin = request.headers.get("Origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-Requested-With",
    "Access-Control-Allow-Credentials": "true",
  };
};

const jsonRes = (request: Request, data: any, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS(request), "Content-Type": "application/json" },
  });

function checkEmailDomain(
  email: string,
  allowedDomains: string[],
  allowedEmails: string[],
) {
  const domain = email.split("@")[1];
  return allowedDomains.includes(domain) || allowedEmails.includes(email);
}

// --- Auth Handler ---
async function handleAuth(request: Request, env: Env) {
  try {
    const { id_token } = (await request.json()) as { id_token?: string };
    if (!id_token) return jsonRes(request, { error: "Missing id_token" }, 400);

    const res = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${id_token}`,
    );
    const gUser: any = await res.json();

    if (
      !res.ok ||
      (env.GOOGLE_CLIENT_ID && gUser.aud !== env.GOOGLE_CLIENT_ID)
    ) {
      return jsonRes(request, { error: "Invalid Google Token" }, 401);
    }

    const user = {
      sub: gUser.sub,
      email: gUser.email,
      name: gUser.name,
      picture: gUser.picture,
    };

    if (!checkEmailDomain(user.email, ALLOWED_EMAIL_DOMAINS(env), ALLOWED_EMAILS(env))) {
      return jsonRes(request, { error: "Unauthorized email domain" }, 403);
    }

    const token = await signJWT(user, env.JWT_SECRET!);

    return jsonRes(request, { token, user });
  } catch (e) {
    return jsonRes(request, { error: "Auth failed" }, 500);
  }
}

// --- Main Worker Export ---
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (request.method === "OPTIONS")
      return new Response(null, { headers: CORS_HEADERS(request) });
    if (pathname === "/auth" && request.method === "POST")
      return handleAuth(request, env);
    if (pathname !== "/api/run" || request.method !== "POST")
      return new Response("Not Found", { status: 404 });

    // 1. Authorize Request (Simple JWT Auth)
    const authHeader = request.headers.get("Authorization") || "";
    const token = authHeader.replace("Bearer ", "");
    const user = await verifyJWT(token, env.JWT_SECRET!);
    if (!user) return jsonRes(request, { error: "Unauthorized" }, 401);
    const formData = await request.formData().catch(() => null);
    const zipFile = formData?.get("project_zip") as File;
    if (!zipFile)
      return jsonRes(request, { error: "Missing project_zip" }, 400);

    // 2. Setup Streaming
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const runId = crypto.randomUUID().split("-")[0];

    const sendLog = async (msg: string) => {
      await writer.write(encoder.encode(`data: [${runId}] ${msg}\n\n`));
    };

    // 3. Execution Logic (Backgrounded so we can return the readable stream immediately)
    (async () => {
      let sandbox: Sandbox | undefined;
      try {
        await sendLog("🚀 Provisioning sandbox...");
        sandbox = getSandbox(env.Sandbox, `dbt-${runId}`);

        // Write file (Using Buffer from node:buffer for Base64)
        const arrayBuf = await zipFile.arrayBuffer();
        await sandbox.writeFile(
          "/workspace/project.zip.base64",
          Buffer.from(arrayBuf).toString("base64"),
        );

        await sendLog("📦 Extracting project...");
        await sandbox.exec(
          "base64 -d /workspace/project.zip.base64 > /workspace/project.zip && unzip -q -o /workspace/project.zip -d /workspace/",
        );

        // Workspace Discovery
        const { stdout: rootPath } = await sandbox.exec(
          "find /workspace -maxdepth 3 -name 'dbt_project.yml' | head -n 1",
        );
        const projectRoot = rootPath.trim()
          ? rootPath.trim().replace("/dbt_project.yml", "")
          : "/workspace";

        const execOpts = {
          cwd: projectRoot,
          env: { DBT_PROFILES_DIR: projectRoot },
        };

        // Helper for streaming commands
        const runStep = async (cmd: string, label: string) => {
          await sendLog(`🛠️ Executing: ${label}...`);
          const stream = await sandbox!.execStream(cmd, execOpts);
          for await (const event of parseSSEStream(stream)) {
            const ev = event as any;
            if (ev.type === "stdout" && ev.data)
              await sendLog(`[${label}] ${ev.data}`);
            if (ev.type === "stderr" && ev.data)
              await sendLog(`[${label} ERROR] ${ev.data}`);
            if (ev.type === "complete" && ev.exitCode !== 0)
              throw new Error(`${label} failed (exit ${ev.exitCode})`);
          }
        };

        // Run Pipeline
        await runStep("python3 convert.py", "python-convert");
        await runStep("dbt deps --no-use-colors", "dbt-deps");
        await runStep("dbt seed --no-use-colors", "dbt-seed");
        await runStep("dbt run --no-use-colors", "dbt-run");

        await sendLog("✅ Pipeline complete!");
      } catch (e: any) {
        await sendLog(`❌ Error: ${e.message}`);
      } finally {
        if (sandbox) {
          await sendLog("🛑 Cleaning up sandbox...");
          await sandbox.destroy().catch(() => {});
        }
        await writer.close();
      }
    })();

    // 4. Return the stream immediately
    return new Response(readable, {
      headers: {
        ...CORS_HEADERS(request),
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  },
};
