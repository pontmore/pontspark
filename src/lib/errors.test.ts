import { friendlyError } from "./errors";

it("names network failures instead of echoing the SDK", () => {
  expect(friendlyError("SdkError.SparkError: Service connection error: error sending request for url (https://api.lightspark.com/): dns error")).toBe("Can't reach the network. Retrying automatically.");
});

it("hides other raw wallet errors", () => {
  expect(friendlyError("SdkError.Generic: invalid state")).toBe("The wallet couldn't finish this step. Retrying automatically.");
});

it("keeps the engine's own sentences", () => {
  expect(friendlyError("Bitcoin lock could not be verified")).toBe("Bitcoin lock could not be verified");
});
