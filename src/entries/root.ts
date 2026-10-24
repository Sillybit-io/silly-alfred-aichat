import { main } from "../app/root";
import { createJxaHost } from "../host/jxa";
import { maintained } from "../store/maintenance";
import { defineEntry } from "../jxa/entry";

defineEntry((argv) => main(maintained(createJxaHost()), argv));
