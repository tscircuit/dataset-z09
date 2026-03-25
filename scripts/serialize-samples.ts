import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SAMPLE_FILE_PATTERN = /^sample\d{6}\.json$/;
const FIRST_100_SAMPLE_COUNT = 100;

const formatNumber = (value: number) => {
  if (!Number.isFinite(value)) return "null";

  const plain = String(value);
  const roundedNumber = Number(value.toFixed(2));
  const rounded = String(roundedNumber);

  return rounded.length < plain.length ? rounded : plain;
};

const stringifyCompact = (value: unknown): string => {
  if (typeof value === "number") return formatNumber(value);

  if (
    typeof value === "string" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stringifyCompact(item)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .map(
        ([key, childValue]) =>
          `${JSON.stringify(key)}:${stringifyCompact(childValue)}`,
      )
      .join(",")}}`;
  }

  return "null";
};

const createSamplesModule = (sampleFileNames: string[]) => {
  const bindings = sampleFileNames.map((fileName) => fileName.replace(".json", ""));
  const importLines = sampleFileNames.map(
    (fileName, index) =>
      `import ${bindings[index]} from "./${fileName}";`,
  );

  return `${importLines.join("\n")}

export { ${bindings.join(", ")} };

export const samples = [${bindings.join(", ")}];

export default samples;
`;
};

const createSamplesDeclarationFile = (sampleFileNames: string[]) => {
  const bindings = sampleFileNames.map((fileName) => fileName.replace(".json", ""));

  return `import type { DatasetSample } from "../lib/types";

${bindings
  .map((binding) => `export const ${binding}: DatasetSample;`)
  .join("\n")}

export const samples: DatasetSample[];

export default samples;
`;
};

const main = async () => {
  const samplesDir = join(process.cwd(), "samples");
  const fileNames = (await readdir(samplesDir))
    .filter((fileName) => SAMPLE_FILE_PATTERN.test(fileName))
    .sort();

  for (const fileName of fileNames) {
    const samplePath = join(samplesDir, fileName);
    const sample = await Bun.file(samplePath).json();
    await writeFile(samplePath, `${stringifyCompact(sample)}\n`);
  }

  await writeFile(join(samplesDir, "index.js"), createSamplesModule(fileNames));
  await writeFile(
    join(samplesDir, "index.d.ts"),
    createSamplesDeclarationFile(fileNames),
  );
  await writeFile(
    join(samplesDir, "first100.js"),
    createSamplesModule(fileNames.slice(0, FIRST_100_SAMPLE_COUNT)),
  );
  await writeFile(
    join(samplesDir, "first100.d.ts"),
    createSamplesDeclarationFile(fileNames.slice(0, FIRST_100_SAMPLE_COUNT)),
  );

  console.log(
    `Serialized ${fileNames.length} samples and generated index/first100 JS plus declarations`,
  );
};

main().catch((error) => {
  console.error("Failed to serialize samples:", error);
  process.exit(1);
});
