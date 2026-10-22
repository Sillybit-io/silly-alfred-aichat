import { defineEntry } from "../../../src/jxa/entry";

defineEntry((argv) => `hello ${argv[0]}`);
