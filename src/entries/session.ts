import { main } from "../app/session";
import { createJxaHost } from "../host/jxa";
import { defineEntry } from "../jxa/entry";

defineEntry((argv) => main(createJxaHost(), argv));
