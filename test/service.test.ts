import { describeServiceContract } from "./support/service-contract.js";

describeServiceContract("in-process", ({ host }) => ({
  client: host.client,
  dispose: () => undefined,
}));
