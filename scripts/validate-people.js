#!/usr/bin/env node
import { readFileSync, readdirSync } from "fs";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const peopleDir = join(root, "people");
const schema = JSON.parse(readFileSync(join(peopleDir, "schema.json"), "utf8"));

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);

const files = readdirSync(peopleDir).filter(
  (f) => f.endsWith(".json") && f !== "schema.json"
);

let errors = 0;

for (const file of files) {
  const handle = basename(file, ".json");
  const data = JSON.parse(readFileSync(join(peopleDir, file), "utf8"));

  if (!validate(data)) {
    console.error(`\n✗ ${file}`);
    for (const err of validate.errors) {
      console.error(`  ${err.instancePath || "root"}: ${err.message}`);
    }
    errors++;
    continue;
  }

  if (data.handle !== handle) {
    console.error(`\n✗ ${file}: "handle" field "${data.handle}" must match filename "${handle}"`);
    errors++;
    continue;
  }

  console.log(`✓ ${file}`);
}

if (errors > 0) {
  console.error(`\n${errors} file(s) failed validation.`);
  process.exit(1);
} else {
  console.log(`\nAll ${files.length} people files valid.`);
}
