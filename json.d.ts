import type { DatasetSample } from "./lib/types";

declare module "*.json" {
  const value: DatasetSample;
  export default value;
}
