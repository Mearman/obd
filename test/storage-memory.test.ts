import { MemoryStorage } from "../src/core/index.js";
import { describeStorageContract } from "./support/storage-contract.js";

describeStorageContract("in-memory", () =>
  Promise.resolve({ storage: new MemoryStorage(), dispose: () => undefined }),
);
