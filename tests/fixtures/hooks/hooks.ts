import { apiBase } from "../../../src/core/payload";
import { curlBinary, curlProtocolArgs } from "../../../src/host/common";
import { defineEntry } from "../../../src/jxa/entry";

defineEntry(() => JSON.stringify({ base: apiBase({ aichat_api_base: "http://127.0.0.1:9/v1" }), curl: curlBinary({ aichat_curl: "/tmp/fake-curl" }), proto: curlProtocolArgs("http://127.0.0.1:9/v1/x") }));
