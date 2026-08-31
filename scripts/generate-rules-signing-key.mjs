/**
 * Generate an ECDSA P-256 key pair for signing extension rule payloads.
 * Prints values for .env — never commit the private key.
 *
 *   node scripts/generate-rules-signing-key.mjs
 *   node scripts/generate-rules-signing-key.mjs --from-env
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pubPath = path.join(root, "extension", "rules-signing-pub.txt");

function writePublicKeyFile(pub) {
  fs.writeFileSync(pubPath, `${pub}\n`);
}

function publicKeyFromPrivate(raw) {
  let material = raw.trim();
  if (
    (material.startsWith('"') && material.endsWith('"')) ||
    (material.startsWith("'") && material.endsWith("'"))
  ) {
    material = material.slice(1, -1);
  }
  material = material.replace(/\\n/g, "\n").trim();
  const key = material.startsWith("-----BEGIN")
    ? createPrivateKey(material)
    : createPrivateKey({
        key: Buffer.from(material.replace(/\s+/g, ""), "base64"),
        format: "der",
        type: "pkcs8",
      });
  if (key.asymmetricKeyType !== "ec") {
    throw new Error("PRIVYDECK_RULES_SIGNING_PRIVATE_KEY must be an EC P-256 key");
  }
  return createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64");
}

if (process.argv.includes("--from-env")) {
  const raw = process.env.PRIVYDECK_RULES_SIGNING_PRIVATE_KEY;
  if (!raw?.trim()) {
    console.error("Set PRIVYDECK_RULES_SIGNING_PRIVATE_KEY, then re-run with --from-env");
    process.exit(1);
  }
  const pub = publicKeyFromPrivate(raw);
  writePublicKeyFile(pub);
  console.log(`Wrote ${pubPath} from the existing private key`);
  process.exit(0);
}

const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const pub = publicKey.export({ type: "spki", format: "der" }).toString("base64");
const priv = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
writePublicKeyFile(pub);

console.log("# Add to server .env (private key never belongs in git or the extension):");
console.log(`PRIVYDECK_RULES_SIGNING_PRIVATE_KEY=${priv}`);
console.log(`PRIVYDECK_RULES_SIGNING_PUBLIC_KEY=${pub}`);
console.log("");
console.log(`# Wrote ${pubPath}`);
console.log("# Rebuild the extension: npm run extension:build");
