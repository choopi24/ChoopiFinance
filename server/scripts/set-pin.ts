/**
 * npm run set-pin — set or reset the app passcode from the terminal.
 *
 * The way back in when you have forgotten it: nothing in the app can reset the
 * passcode without the current one, but anyone with a shell on the host machine
 * already has the database, so a local reset costs no security.
 *
 * Prints the hash as well, so you can paste it into APP_PIN_HASH instead if you
 * would rather the service manager own it than a file on disk.
 */

import { createInterface } from "readline";
import { hashPin, PIN_FILE, pinIsFromEnv, savePin } from "../src/security/pin.js";

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer.trim()); }));
}

const run = async () => {
  const fromArg = process.argv[2];
  const pin = fromArg ?? await ask("New passcode (4–12 digits): ");

  if (pinIsFromEnv()) {
    const hash = await hashPin(pin);
    console.log("\nAPP_PIN_HASH is set in the environment, so the file is not used.");
    console.log("Put this in server/.env and restart:\n");
    console.log(`APP_PIN_HASH=${hash}\n`);
    return;
  }

  const confirm = fromArg ?? await ask("Repeat it: ");
  if (pin !== confirm) {
    console.error("\nThey don't match. Nothing was changed.");
    process.exitCode = 1;
    return;
  }

  const hash = await savePin(pin);
  console.log(`\n✓ Passcode saved to ${PIN_FILE}`);
  console.log("  (that file is gitignored and readable only by you)\n");
  console.log("If you'd rather keep it in the environment, delete that file and set:\n");
  console.log(`APP_PIN_HASH=${hash}\n`);
  console.log("Restart the server for either change to take effect.");
};

run().catch(err => {
  console.error(`\n✗ ${(err as Error).message}`);
  process.exitCode = 1;
});
