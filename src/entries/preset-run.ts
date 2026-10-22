import { main } from "../app/preset-run";
import { createJxaHost } from "../host/jxa";
import { defineEntry } from "../jxa/entry";

defineEntry((argv) => main(createJxaHost(), argv));
