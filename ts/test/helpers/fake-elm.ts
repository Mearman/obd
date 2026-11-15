/**
 * The scripted adapter and control units live in `src/core/simulator.ts`, because the `simulate`
 * command serves them too; this re-exports them under the names the tests use.
 */

export {
  FakeElmCore,
  KwpEcu,
  SIMULATED_VIN,
  UdsEcu,
  adapterTransport as fakeTransport,
  isotpFrames,
  type FakeElmOptions,
  type UnitResponder as Responder,
} from "../../src/core/index.js";
