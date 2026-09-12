/**
 * Ledger DMK packages ship broken Node ESM (extensionless re-exports).
 * Load them via CJS from the gateway workspace root.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), "../package.json"));

export const {
  DeviceManagementKitBuilder,
  DeviceActionStatus,
  OpenAppDeviceAction,
}: {
  DeviceManagementKitBuilder: typeof import("@ledgerhq/device-management-kit").DeviceManagementKitBuilder;
  DeviceActionStatus: typeof import("@ledgerhq/device-management-kit").DeviceActionStatus;
  OpenAppDeviceAction: typeof import("@ledgerhq/device-management-kit").OpenAppDeviceAction;
} = require("@ledgerhq/device-management-kit");

export type DeviceActionState<TOutput> =
  import("@ledgerhq/device-management-kit").DeviceActionState<TOutput, unknown, unknown>;

export const { nodeHidTransportFactory } = require("@ledgerhq/device-transport-kit-node-hid") as {
  nodeHidTransportFactory: typeof import("@ledgerhq/device-transport-kit-node-hid").nodeHidTransportFactory;
};

export const { SignerEthBuilder } = require("@ledgerhq/device-signer-kit-ethereum") as {
  SignerEthBuilder: typeof import("@ledgerhq/device-signer-kit-ethereum").SignerEthBuilder;
};

export const { ContextModuleBuilder, ContextModuleChainID } = require("@ledgerhq/context-module") as {
  ContextModuleBuilder: typeof import("@ledgerhq/context-module").ContextModuleBuilder;
  ContextModuleChainID: typeof import("@ledgerhq/context-module").ContextModuleChainID;
};
