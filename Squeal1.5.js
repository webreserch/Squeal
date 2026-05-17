(function (root, factory) {
  if (typeof define === "function" && define.amd) {
    define([], factory);
  } else if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.SqueakConverter = factory();
  }
}(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------- helpers ----------

  // Skip a Smalltalk single-quoted string starting at index `start` (which
  // must point at the opening `'`), treating `''` as an escaped apostrophe.
  // Returns the index AFTER the closing quote (or end-of-string if unterminated).
  function skipSmalltalkString(str, start) {
    var idx = start + 1;
    while (idx < str.length) {
      if (str.charAt(idx) === "'") {
        if (str.charAt(idx + 1) === "'") { idx += 2; continue; }
        return idx + 1;
      }
      idx++;
    }
    return str.length;
  }

  function findMatching(s, openIdx, openCh, closeCh) {
    var depth = 0, inStr = null;
    for (var i = openIdx; i < s.length; i++) {
      var c = s.charAt(i);
      if (inStr) {
        if (c === "\\") { i++; continue; }
        if (c === inStr) inStr = null;
      } else if (c === '"' || c === "'" || c === "`") {
        inStr = c;
      } else if (c === openCh) {
        depth++;
      } else if (c === closeCh) {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  function splitTopLevel(s, sep) {
    var parts = [], depth = 0, inStr = null, current = "";
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (inStr) {
        current += c;
        if (c === "\\" && i + 1 < s.length) { current += s.charAt(i + 1); i++; continue; }
        if (c === inStr) inStr = null;
      } else if (c === '"' || c === "'" || c === "`") {
        inStr = c; current += c;
      } else if (c === "(" || c === "[" || c === "{") {
        depth++; current += c;
      } else if (c === ")" || c === "]" || c === "}") {
        depth--; current += c;
      } else if (c === sep && depth === 0) {
        parts.push(current.replace(/^\s+|\s+$/g, ""));
        current = "";
      } else {
        current += c;
      }
    }
    var last = current.replace(/^\s+|\s+$/g, "");
    if (last) parts.push(last);
    return parts;
  }

  function isStringLiteral(s) {
    s = s.replace(/^\s+|\s+$/g, "");
    return (/^'(?:[^'\\]|\\.|'')*'$/.test(s)) || (/^"(?:[^"\\]|\\.)*"$/.test(s));
  }

  function isNumericLiteral(s) {
    return /^-?\d+(?:\.\d+)?$/.test(s.replace(/^\s+|\s+$/g, ""));
  }

  function isSimpleAtom(s) {
    s = s.replace(/^\s+|\s+$/g, "");
    return isStringLiteral(s) || isNumericLiteral(s) ||
      s === "true" || s === "false" || s === "nil";
  }

  function convertStringLiteral(jsStr) {
    var first = jsStr.charAt(0);
    var inner = jsStr.slice(1, -1);

    if (first === "`") {
      // State-aware ${...} extraction: track quotes and backticks within the
      // expression so braces inside strings (e.g. ${foo("}")}) don't fool us.
      var out = "";
      var k = 0;
      while (k < inner.length) {
        if (inner.charAt(k) === "$" && inner.charAt(k + 1) === "{") {
          var depth = 1, j = k + 2, inStr = null;
          while (j < inner.length && depth > 0) {
            var ch = inner.charAt(j);
            if (inStr) {
              if (ch === "\\") { j += 2; continue; }
              if (ch === inStr) inStr = null;
            } else if (ch === '"' || ch === "'" || ch === "`") {
              inStr = ch;
            } else if (ch === "{") depth++;
            else if (ch === "}") {
              depth--;
              if (depth === 0) break;
            }
            j++;
          }
          if (j < inner.length) {
            var exprInner = inner.slice(k + 2, j).replace(/^\s+|\s+$/g, "");
            out += "' , (" + exprInner + ") printString , '";
            k = j + 1;
            continue;
          }
        }
        // Literal text — double any apostrophes for Smalltalk string escaping.
        out += inner.charAt(k) === "'" ? "''" : inner.charAt(k);
        k++;
      }
      return "'" + out + "'";
    }
    if (first === '"' || first === "'") {
      inner = inner
        .replace(/\\n/g, String.fromCharCode(10))
        .replace(/\\t/g, String.fromCharCode(9))
        .replace(/\\r/g, String.fromCharCode(13))
        .replace(/\\'/g, "'")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\")
        .replace(/'/g, "''");
      return "'" + inner + "'";
    }
    return jsStr;
  }

  function removeSemicolon(s) {
    return s.replace(/;$/, "").replace(/\s+$/, "");
  }

  // Apply `fn` only to portions of `s` that are OUTSIDE Smalltalk single-quoted
  // strings. Inside strings, '' is the escape for a literal apostrophe.
  function mapOutsideStrings(s, fn) {
    var out = "", i = 0, buf = "";
    while (i < s.length) {
      if (s.charAt(i) === "'") {
        if (buf) { out += fn(buf); buf = ""; }
        var j = i + 1, lit = "'";
        while (j < s.length) {
          if (s.charAt(j) === "'" && s.charAt(j + 1) === "'") {
            lit += "''"; j += 2; continue;
          }
          if (s.charAt(j) === "'") { lit += "'"; j++; break; }
          lit += s.charAt(j); j++;
        }
        out += lit;
        i = j;
        continue;
      }
      buf += s.charAt(i);
      i++;
    }
    if (buf) out += fn(buf);
    return out;
  }

  // Walk a destructuring pattern body (the text between `{` and `}`) and
  // return every local variable name introduced, including nested patterns.
  //   "a, b: alias, c = 1"            → ["a", "alias", "c"]
  //   "a: {b, c}, d: [e, f]"          → ["b", "c", "e", "f"]
  function collectDestructuredNames(patternBody) {
    var names = [];
    var entries = splitTopLevel(patternBody, ",");
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i].replace(/^\s+|\s+$/g, "");
      if (!entry) continue;
      // strip default value (=...) at top level
      var eqParts = splitTopLevel(entry, "=");
      entry = eqParts[0].replace(/^\s+|\s+$/g, "");
      // split key:target at top level
      var colonParts = splitTopLevel(entry, ":");
      var target = (colonParts.length > 1 ? colonParts.slice(1).join(":") : entry)
        .replace(/^\s+|\s+$/g, "");
      if (target.charAt(0) === "{") {
        var endB = findMatching(target, 0, "{", "}");
        if (endB !== -1) {
          collectDestructuredNames(target.slice(1, endB)).forEach(function (n) { names.push(n); });
        }
      } else if (target.charAt(0) === "[") {
        var endA = findMatching(target, 0, "[", "]");
        if (endA !== -1) {
          target.slice(1, endA).split(",").forEach(function (v) {
            var n = v.replace(/^\s+|\s+$/g, "").split("=")[0].replace(/^\s+|\s+$/g, "");
            if (n && n !== "_") names.push(n);
          });
        }
      } else {
        // bare identifier (possibly with leading ...)
        var n2 = target.replace(/^\.\.\.\s*/, "");
        if (n2) names.push(n2);
      }
    }
    return names;
  }

  // Emit Smalltalk assignments for a destructured object pattern.
  //   patternBody: the text between `{` and `}` of the LHS pattern
  //   srcExpr:    already-converted RHS expression
  //   indent:     leading indent string
  // Returns multi-line Squeak text.
  function emitObjectDestructure(patternBody, srcExpr, indent) {
    var lines = [];
    var entries = splitTopLevel(patternBody, ",");
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i].replace(/^\s+|\s+$/g, "");
      if (!entry) continue;
      var eqParts = splitTopLevel(entry, "=");
      var lhs = eqParts[0].replace(/^\s+|\s+$/g, "");
      var defaultVal = eqParts.length > 1
        ? eqParts.slice(1).join("=").replace(/^\s+|\s+$/g, "")
        : null;
      var colonParts = splitTopLevel(lhs, ":");
      var key, target;
      if (colonParts.length > 1) {
        key = colonParts[0].replace(/^\s+|\s+$/g, "");
        target = colonParts.slice(1).join(":").replace(/^\s+|\s+$/g, "");
      } else {
        key = lhs; target = lhs;
      }
      var access = defaultVal
        ? "(" + srcExpr + " at: #" + key + " ifAbsent: [" + convertExpression(defaultVal) + "])"
        : "(" + srcExpr + " at: #" + key + ")";
      if (target.charAt(0) === "{") {
        var endB = findMatching(target, 0, "{", "}");
        if (endB !== -1) {
          lines.push(emitObjectDestructure(target.slice(1, endB), access, indent));
          continue;
        }
      }
      if (target.charAt(0) === "[") {
        var endA = findMatching(target, 0, "[", "]");
        if (endA !== -1) {
          var elems = target.slice(1, endA).split(",");
          for (var j = 0; j < elems.length; j++) {
            var elem = elems[j].replace(/^\s+|\s+$/g, "");
            if (!elem) continue;
            var elemParts = elem.split("=");
            var n = elemParts[0].replace(/^\s+|\s+$/g, "");
            var elemDefault = elemParts.length > 1
              ? convertExpression(elemParts.slice(1).join("="))
              : null;
            if (!n || n === "_") continue;
            var atExpr = elemDefault
              ? "(" + access + " at: " + (j + 1) + " ifAbsent: [" + elemDefault + "])"
              : access + " at: " + (j + 1);
            lines.push(indent + n + " := " + atExpr + ".");
          }
          continue;
        }
      }
      lines.push(indent + target.replace(/^\.\.\.\s*/, "") + " := " + access + ".");
    }
    return lines.join("\n");
  }

  // Convert a JS object-literal body "a: 1, b: foo()" to a Squeak Dictionary
  // expression. Returns null if the contents don't look like an object literal
  // (so callers can leave the original `{...}` alone, e.g. for code blocks).
  function convertObjectLiteral(inner) {
    var parts = splitTopLevel(inner, ",");
    if (parts.length === 0) return "Dictionary new";
    var entries = [];
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].replace(/^\s+|\s+$/g, "");
      if (!p) continue;
      // Must be key: value — keys are identifiers, numbers, or string literals
      var m = p.match(/^(\w+|'[^']*'|"[^"]*")\s*:\s*([\s\S]+)$/);
      if (!m) return null;
      var key = m[1];
      var val = m[2];
      var keyExpr = /^\w+$/.test(key) ? "#" + key : key;
      entries.push("at: " + keyExpr + " put: (" + val + ")");
    }
    return "(Dictionary new " + entries.join("; ") + "; yourself)";
  }

  function getIndent(line) {
    var m = line.match(/^(\s*)/);
    return m ? m[1] : "";
  }

  function stripLineComment(line) {
    var inStr = null;
    for (var i = 0; i < line.length - 1; i++) {
      var c = line.charAt(i);
      if (!inStr && (c === '"' || c === "'" || c === "`")) {
        inStr = c;
      } else if (inStr && c === inStr && line.charAt(i - 1) !== "\\") {
        inStr = null;
      } else if (!inStr && c === "/" && line.charAt(i + 1) === "/") {
        return {
          code: line.slice(0, i).replace(/\s+$/, ""),
          comment: line.slice(i + 2).replace(/^\s+|\s+$/g, "")
        };
      }
    }
    return { code: line, comment: "" };
  }

  // ---------- expression converter ----------

  function convertExpression(expr) {
    expr = expr.replace(/^\s+|\s+$/g, "");

    // String literals first (so subsequent regex doesn't mangle them).
    // After this, the only quotes in `expr` are Smalltalk single quotes.
    expr = expr.replace(/(`[^`]*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, function (m) {
      return convertStringLiteral(m);
    });

    // Now safely strip async/await — Squeak is synchronous.
    // Works in any expression position (ternary arms, args, etc).
    // Skip rewrites inside Smalltalk strings (single-quoted).
    expr = mapOutsideStrings(expr, function (chunk) {
      return chunk
        .replace(/\basync\s+/g, "")
        .replace(/\bawait\s+/g, "");
    });

    // Private fields: this.#name → this.name (then handled by `this.` rules).
    // Bare #name (in expressions like obj.#x) likewise drops the #.
    expr = mapOutsideStrings(expr, function (chunk) {
      return chunk.replace(/(\.)#(\w+)/g, "$1$2");
    });

    // super.method(args) → super method: a and: b ; super() → super new.
    // Uses a balanced-paren scanner so nested calls like `super.foo(bar(baz), qux)`
    // are correctly extracted. Instead of negative-lookbehind (not supported in
    // older Safari/JSC), captures the preceding char in group 1 and bails when
    // it's `.` — so `obj.super(...)` is left alone.
    expr = mapOutsideStrings(expr, function (chunk) {
      var pattern = /(^|[^.])\bsuper(?:\.(\w+))?\s*\(/g;
      var out = "", lastIdx = 0, m;
      while ((m = pattern.exec(chunk)) !== null) {
        var prev = m[1];
        var matchStart = m.index + prev.length;
        var openIdx = m.index + m[0].length - 1;
        var closeIdx = findMatching(chunk, openIdx, "(", ")");
        if (closeIdx === -1) continue;
        var args = chunk.slice(openIdx + 1, closeIdx).replace(/^\s+|\s+$/g, "");
        var method = m[2];
        var parts = args ? splitTopLevel(args, ",").filter(Boolean)
          .map(function (p) { return p.replace(/^\s+|\s+$/g, ""); }) : [];
        var rendered;
        if (method) {
          rendered = parts.length === 0 ? "super " + method
            : "super " + method + ": " + parts.join(" and: ");
        } else {
          rendered = parts.length === 0 ? "super new"
            : "super new: " + parts.join(" and: ");
        }
        out += chunk.slice(lastIdx, matchStart) + rendered;
        lastIdx = closeIdx + 1;
        pattern.lastIndex = lastIdx;
      }
      return out + chunk.slice(lastIdx);
    });

    var BLK_O = "\u0001", BLK_C = "\u0002";

    // Object literal returned from arrow: ({ a: 1, b: 2 }) → Dictionary expr.
    // Also handles bare top-level object literals wrapped in parens.
    expr = (function (s) {
      var out = "", i = 0;
      while (i < s.length) {
        if (s.charAt(i) === "(" && /\s*\{/.test(s.slice(i + 1))) {
          var openP = i;
          var afterOpen = i + 1;
          while (afterOpen < s.length && /\s/.test(s.charAt(afterOpen))) afterOpen++;
          if (s.charAt(afterOpen) === "{") {
            var closeB = findMatching(s, afterOpen, "{", "}");
            if (closeB !== -1) {
              var afterClose = closeB + 1;
              while (afterClose < s.length && /\s/.test(s.charAt(afterClose))) afterClose++;
              if (s.charAt(afterClose) === ")") {
                var dict = convertObjectLiteral(s.slice(afterOpen + 1, closeB));
                if (dict) {
                  out += dict;
                  i = afterClose + 1;
                  continue;
                }
              }
            }
          }
        }
        out += s.charAt(i);
        i++;
      }
      return out;
    })(expr);

    // Spread operator — best-effort, only outside Smalltalk strings.
    // [...arr] → arr copy ; otherwise drop the "..." and keep the receiver.
    expr = mapOutsideStrings(expr, function (chunk) {
      return chunk
        .replace(/\[\s*\.\.\.\s*(\w+)\s*\]/g, "$1 copy")
        .replace(/\.\.\.\s*(\w+)/g, "$1");
    });

    // console.log / error / warn → Transcript show: ... ; cr.
    expr = (function (s) {
      var out = "", i = 0;
      while (i < s.length) {
        var rest = s.slice(i);
        var m = rest.match(/^console\.(?:log|error|warn|info)\s*\(/);
        if (!m) { out += s.charAt(i); i++; continue; }
        var openIdx = i + m[0].length - 1;
        var closeIdx = findMatching(s, openIdx, "(", ")");
        if (closeIdx === -1) { out += s.charAt(i); i++; continue; }
        var argsRaw = s.slice(openIdx + 1, closeIdx);
        var parts = splitTopLevel(argsRaw, ",");
        if (parts.length === 0) {
          out += "Transcript cr";
        } else if (parts.length === 1) {
          var only = parts[0];
          if (isStringLiteral(only)) {
            out += "Transcript showCrLf: " + only;
          } else if (only.indexOf("+") !== -1 && /['"]/.test(only)) {
            // String concatenation expression like "Hello " + name
            // Convert + to , and add printString around non-string atoms
            var concatParts = splitTopLevel(only, "+").map(function (p) {
              return isStringLiteral(p) ? p : "(" + p + ") printString";
            });
            out += "Transcript showCrLf: " + concatParts.join(" , ");
          } else {
            out += "Transcript showCrLf: (" + only + ") printString";
          }
        } else {
          var pieces = parts.map(function (a) {
            if (isStringLiteral(a)) return "Transcript show: " + a;
            return "Transcript show: (" + a + ") printString";
          });
          out += pieces.join("; show: ' '; ").replace(/^Transcript show: /, "Transcript show: ").
            replace(/; show: ' '; Transcript show: /g, "; show: ' '; show: ") + "; cr";
          // Fix: collapse subsequent "Transcript show:" duplicates
          out = out.replace(/(Transcript show: [^;]+); show: ' '; Transcript show: /g, "$1; show: ' '; show: ");
        }
        i = closeIdx + 1;
      }
      return out;
    })(expr);

    // alert / prompt / confirm — browser dialog APIs
    expr = (function (s) {
      var out = "", i = 0;
      while (i < s.length) {
        var rest = s.slice(i);
        var m = rest.match(/^(alert|prompt|confirm)\s*\(/);
        if (!m) { out += s.charAt(i); i++; continue; }
        // Skip if preceded by `.` (method call) or word char (identifier)
        var prev = i > 0 ? s.charAt(i - 1) : "";
        if (prev === "." || /\w/.test(prev)) { out += s.charAt(i); i++; continue; }
        var openIdx = i + m[0].length - 1;
        var closeIdx = findMatching(s, openIdx, "(", ")");
        if (closeIdx === -1) { out += s.charAt(i); i++; continue; }
        var argRaw = s.slice(openIdx + 1, closeIdx).replace(/^\s+|\s+$/g, "");
        var arg = argRaw ? (isStringLiteral(argRaw) ? argRaw : "(" + argRaw + ") printString") : "''";
        var fn = m[1];
        if (fn === "alert") {
          out += "(PopUpMenu inform: " + arg + ")";
        } else if (fn === "confirm") {
          out += "(PopUpMenu confirm: " + arg + ")";
        } else {
          // prompt(msg) or prompt(msg, default) → FillInTheBlank request:initialAnswer:
          var parts = splitTopLevel(argRaw, ",");
          if (parts.length >= 2) {
            var p2 = isStringLiteral(parts[1]) ? parts[1] : "(" + parts[1] + ") printString";
            var p1 = isStringLiteral(parts[0]) ? parts[0] : "(" + parts[0] + ") printString";
            out += "(FillInTheBlank request: " + p1 + " initialAnswer: " + p2 + ")";
          } else {
            out += "(FillInTheBlank request: " + arg + ")";
          }
        }
        i = closeIdx + 1;
      }
      return out;
    })(expr);

    // typeof x === 'type'
    // All of the following rewrites operate on JS-keyword/operator tokens
    // that must NEVER be applied inside Smalltalk string literals (which at
    // this point have already been translated from JS strings). They are
    // grouped into a single `mapOutsideStrings` pass for both correctness
    // (a JS source string `"null && undefined"` survives unchanged) and
    // performance (one walk instead of nine).
    expr = mapOutsideStrings(expr, function (chunk) {
      // typeof x === 'string' → x isKindOf: String
      chunk = chunk.replace(/typeof\s+(\w+)\s*===?\s*'(\w+)'/g, function (_m, v, t) {
        var typeMap = {
          string: "String", number: "Number", boolean: "Boolean",
          object: "Object", "function": "BlockClosure", undefined: "UndefinedObject"
        };
        return v + " isKindOf: " + (typeMap[t] || t);
      });
      // null / undefined → nil
      chunk = chunk.replace(/\bnull\b/g, "nil").replace(/\bundefined\b/g, "nil");
      // ++ / --
      chunk = chunk.replace(/(\w+)\+\+/g, "$1 := $1 + 1");
      chunk = chunk.replace(/(\w+)--/g, "$1 := $1 - 1");
      chunk = chunk.replace(/\+\+(\w+)/g, "$1 := $1 + 1");
      chunk = chunk.replace(/--(\w+)/g, "$1 := $1 - 1");
      // Compound assigns
      chunk = chunk.replace(/(\w+)\s*\+=\s*(.+)/, "$1 := $1 + $2");
      chunk = chunk.replace(/(\w+)\s*-=\s*(.+)/, "$1 := $1 - $2");
      chunk = chunk.replace(/(\w+)\s*\*=\s*(.+)/, "$1 := $1 * $2");
      chunk = chunk.replace(/(\w+)\s*\/=\s*(.+)/, "$1 := $1 / $2");
      // Comparison and logical operators
      chunk = chunk.replace(/===/g, "=");
      chunk = chunk.replace(/!==/g, "~=");
      chunk = chunk.replace(/==/g, "=");
      chunk = chunk.replace(/!=/g, "~=");
      chunk = chunk.replace(/&&/g, " & ");
      chunk = chunk.replace(/\|\|/g, " | ");
      chunk = chunk.replace(/!(\w+)/g, "$1 not");
      // Modulo: a % b → a \\ b   (Smalltalk uses \\ for modulo)
      chunk = chunk.replace(/(\w+|\))\s*%\s*(\w+|\()/g, "$1 \\\\ $2");
      return chunk;
    });

    // Arrow functions — balanced-brace aware, with multi-statement block bodies
    expr = (function (s) {
      function convertArrowBody(body) {
        // Split body into statements, convert each, last expr becomes ^expr (return)
        var stmts = splitTopLevel(body, ";").filter(function (x) { return x.length > 0; });
        if (stmts.length === 0) return "";
        var converted = stmts.map(function (st, idx) {
          st = st.replace(/^\s+|\s+$/g, "");
          var retM = st.match(/^return\s+([\s\S]+)$/);
          if (retM) return "^" + convertExpression(retM[1]);
          if (st === "return") return "^nil";
          // implicit return on last statement of arrow with block body
          if (idx === stmts.length - 1 && !/^(?:if|while|for|var|let|const)\b/.test(st)) {
            return "^" + convertExpression(st);
          }
          return convertExpression(st);
        });
        return converted.join(". ");
      }
      function buildBlock(paramStr, body) {
        var params = splitTopLevel(paramStr, ",").filter(Boolean);
        var pl = params.map(function (x) { return ":" + x.split("=")[0].replace(/^\s+|\s+$/g, ""); }).join(" ");
        return "[" + pl + (pl ? " | " : "") + body + " ]";
      }
      var out = "", i = 0;
      while (i < s.length) {
        // (...)=>{...} or (...)=>expr
        if (s.charAt(i) === "(") {
          var closeP = findMatching(s, i, "(", ")");
          if (closeP !== -1) {
            var afterP = s.slice(closeP + 1).match(/^\s*=>\s*/);
            if (afterP) {
              var paramStr = s.slice(i + 1, closeP);
              var bodyStart = closeP + 1 + afterP[0].length;
              if (s.charAt(bodyStart) === "{") {
                var closeB = findMatching(s, bodyStart, "{", "}");
                if (closeB !== -1) {
                  var body = convertArrowBody(s.slice(bodyStart + 1, closeB));
                  out += buildBlock(paramStr, body);
                  i = closeB + 1;
                  continue;
                }
              } else {
                // expression body — read until top-level , ) or end
                var depth = 0, j = bodyStart, inStr = null;
                while (j < s.length) {
                  var c = s.charAt(j);
                  if (inStr) {
                    if (c === "\\") { j += 2; continue; }
                    if (c === inStr) inStr = null;
                  } else if (c === '"' || c === "'" || c === "`") inStr = c;
                  else if (c === "(" || c === "[" || c === "{") depth++;
                  else if (c === ")" || c === "]" || c === "}") {
                    if (depth === 0) break;
                    depth--;
                  } else if ((c === "," || c === ";") && depth === 0) break;
                  j++;
                }
                var body2 = s.slice(bodyStart, j).replace(/^\s+|\s+$/g, "");
                out += buildBlock(paramStr, convertExpression(body2));
                i = j;
                continue;
              }
            }
          }
        }
        // single-param: x => expr
        var single = s.slice(i).match(/^(\w+)\s*=>\s*/);
        if (single && (i === 0 || /[\s(,\[]/.test(s.charAt(i - 1)))) {
          var bodyStart2 = i + single[0].length;
          if (s.charAt(bodyStart2) === "{") {
            var closeB2 = findMatching(s, bodyStart2, "{", "}");
            if (closeB2 !== -1) {
              var body3 = convertArrowBody(s.slice(bodyStart2 + 1, closeB2));
              out += "[:" + single[1] + " | " + body3 + " ]";
              i = closeB2 + 1;
              continue;
            }
          } else {
            var depth2 = 0, k = bodyStart2, inStr2 = null;
            while (k < s.length) {
              var c2 = s.charAt(k);
              if (inStr2) {
                if (c2 === "\\") { k += 2; continue; }
                if (c2 === inStr2) inStr2 = null;
              } else if (c2 === '"' || c2 === "'" || c2 === "`") inStr2 = c2;
              else if (c2 === "(" || c2 === "[" || c2 === "{") depth2++;
              else if (c2 === ")" || c2 === "]" || c2 === "}") {
                if (depth2 === 0) break;
                depth2--;
              } else if ((c2 === "," || c2 === ";") && depth2 === 0) break;
              k++;
            }
            var body4 = s.slice(bodyStart2, k).replace(/^\s+|\s+$/g, "");
            out += "[:" + single[1] + " | " + convertExpression(body4) + " ]";
            i = k;
            continue;
          }
        }
        out += s.charAt(i);
        i++;
      }
      return out;
    })(expr);

    // Ternary: cond ? a : b → (cond) ifTrue: [a] ifFalse: [b].
    // Runs AFTER arrow-function conversion so `x => x ? 1 : 2` is parsed as
    // `x => (x ? 1 : 2)` — by this point the arrow body has already been
    // recursively converted and the `?` inside it is no longer at depth 0.
    // Runs BEFORE keyword-colon rewrites (`add:`, `at:put:`, etc.) so the
    // `:` we scan for is unambiguously the ternary separator. Both arms
    // recurse through convertExpression for nested-ternary symmetry. Block
    // brackets are emitted as U+0001/U+0002 sentinels so the later array-
    // literal handler does not mistake `[a]` for an array — sentinels are
    // restored to `[`/`]` at the end of convertExpression. Recursively
    // returned arms are re-sealed so their restored brackets survive too.
    expr = (function convertTernary(s) {
      // Peel a fully-enclosing outer `(...)` so `(b ? c : d)` is detected.
      var stripped = s.replace(/^\s+|\s+$/g, "");
      if (stripped.charAt(0) === "(" && findMatching(stripped, 0, "(", ")") === stripped.length - 1) {
        var inner = stripped.slice(1, -1);
        var converted = convertTernary(inner);
        if (converted !== inner) return "(" + converted + ")";
      }
      var depth = 0, qPos = -1;
      for (var k = 0; k < s.length; k++) {
        var c = s.charAt(k);
        if (c === "'") { k = skipSmalltalkString(s, k) - 1; continue; }
        if (c === "(" || c === "[" || c === "{") depth++;
        else if (c === ")" || c === "]" || c === "}") depth--;
        else if (depth === 0 && c === "?") { qPos = k; break; }
      }
      if (qPos === -1) return s;
      var d2 = 0, qDepth = 0, cPos = -1;
      for (var j = qPos + 1; j < s.length; j++) {
        var ch = s.charAt(j);
        if (ch === "'") { j = skipSmalltalkString(s, j) - 1; continue; }
        if (ch === "(" || ch === "[" || ch === "{") d2++;
        else if (ch === ")" || ch === "]" || ch === "}") d2--;
        else if (d2 === 0 && ch === "?") qDepth++;
        else if (d2 === 0 && ch === ":") {
          if (qDepth === 0) { cPos = j; break; }
          qDepth--;
        }
      }
      if (cPos === -1) return s;
      var cond = s.slice(0, qPos).replace(/^\s+|\s+$/g, "");
      var thenSrc = s.slice(qPos + 1, cPos).replace(/^\s+|\s+$/g, "");
      var elseSrc = s.slice(cPos + 1).replace(/^\s+|\s+$/g, "");
      function reseal(s2) { return s2.replace(/\[/g, BLK_O).replace(/\]/g, BLK_C); }
      return "(" + convertExpression(cond) + ") ifTrue: " + BLK_O +
        reseal(convertExpression(thenSrc)) + BLK_C + " ifFalse: " + BLK_O +
        reseal(convertExpression(elseSrc)) + BLK_C;
    })(expr);

    // Array.isArray
    expr = expr.replace(/Array\.isArray\((\w+)\)/g, "$1 isKindOf: Array");

    // Array / collection methods.
    // Methods that take callbacks (map/filter/forEach/find/reduce) use a
    // balanced-paren scanner so nested expressions like `(x) ifTrue: [...]`
    // (produced by ternary conversion) don't break naive `[^)]+` capture.
    function replaceMethodCall(s, methodName, render) {
      var pattern = new RegExp("(\\w+(?:\\.\\w+)*)\\." + methodName + "\\(", "g");
      var out = "", lastIdx = 0, m;
      pattern.lastIndex = 0;
      while ((m = pattern.exec(s)) !== null) {
        var openIdx = m.index + m[0].length - 1;
        var closeIdx = findMatching(s, openIdx, "(", ")");
        if (closeIdx === -1) continue;
        out += s.slice(lastIdx, m.index) + render(m[1], s.slice(openIdx + 1, closeIdx));
        lastIdx = closeIdx + 1;
        pattern.lastIndex = lastIdx;
      }
      return out + s.slice(lastIdx);
    }
    expr = expr.replace(/(\w+)\.push\(([^)]+)\)/g, "$1 add: $2");
    expr = expr.replace(/(\w+)\.pop\(\)/g, "$1 removeLast");
    expr = expr.replace(/(\w+)\.shift\(\)/g, "$1 removeFirst");
    expr = expr.replace(/(\w+)\.length/g, "$1 size");
    expr = expr.replace(/(\w+)\.toString\(\)/g, "$1 printString");
    expr = expr.replace(/(\w+)\.includes\(([^)]+)\)/g, "$1 includes: $2");
    expr = expr.replace(/(\w+)\.indexOf\(([^)]+)\)/g, "$1 indexOf: $2");
    expr = expr.replace(/(\w+)\.join\(([^)]*)\)/g, function (_m, arr, sep) {
      return arr + " inject: '' into: [:acc :el | acc , " + (sep || "''") + " , el]";
    });
    expr = expr.replace(/(\w+)\.slice\(([^,)]+),\s*([^)]+)\)/g, "$1 copyFrom: ($2 + 1) to: $3");
    expr = expr.replace(/(\w+)\.slice\(([^)]+)\)/g, "$1 copyFrom: ($2 + 1) to: $1 size");
    expr = replaceMethodCall(expr, "map",     function (r, a) { return r + " collect: " + a; });
    expr = replaceMethodCall(expr, "filter",  function (r, a) { return r + " select: " + a; });
    expr = replaceMethodCall(expr, "forEach", function (r, a) { return r + " do: " + a; });
    expr = replaceMethodCall(expr, "find",    function (r, a) { return r + " detect: " + a; });
    expr = replaceMethodCall(expr, "reduce",  function (r, a) {
      var parts = splitTopLevel(a, ",").map(function (p) { return p.replace(/^\s+|\s+$/g, ""); });
      if (parts.length >= 2) return r + " inject: " + parts[1] + " into: " + parts[0];
      return r + " inject: nil into: " + a;
    });
    expr = expr.replace(/(\w+)\.sort\(\)/g, "$1 asSortedCollection");

    // Math.*
    expr = expr.replace(/Math\.floor\(([^)]+)\)/g, "($1) floor");
    expr = expr.replace(/Math\.ceil\(([^)]+)\)/g, "($1) ceiling");
    expr = expr.replace(/Math\.round\(([^)]+)\)/g, "($1) rounded");
    expr = expr.replace(/Math\.abs\(([^)]+)\)/g, "($1) abs");
    expr = expr.replace(/Math\.sqrt\(([^)]+)\)/g, "($1) sqrt");
    expr = expr.replace(/Math\.max\(([^,)]+),\s*([^)]+)\)/g, "$1 max: $2");
    expr = expr.replace(/Math\.min\(([^,)]+),\s*([^)]+)\)/g, "$1 min: $2");
    expr = expr.replace(/Math\.pow\(([^,)]+),\s*([^)]+)\)/g, "$1 raisedTo: $2");
    expr = expr.replace(/Math\.random\(\)/g, "Random new next");
    expr = expr.replace(/Math\.PI/g, "Float pi");

    // parseInt / parseFloat
    expr = expr.replace(/parseInt\(([^,)]+)[^)]*\)/g, "$1 asInteger");
    expr = expr.replace(/parseFloat\(([^)]+)\)/g, "$1 asFloat");

    // Object.keys / values
    expr = expr.replace(/Object\.keys\((\w+)\)/g, "$1 keys");
    expr = expr.replace(/Object\.values\((\w+)\)/g, "$1 values");

    // new ClassName(...)
    expr = expr.replace(/new\s+(\w+)\(\)/g, "$1 new");
    expr = expr.replace(/new\s+(\w+)\(([^)]+)\)/g, "$1 new: $2");

    // Array subscript vs literal — disambiguate by context.
    // arr[N] (preceded by identifier or `)` or `]`) → (arr at: N+1)
    // [a, b, ...] (literal context) → #(...) for atoms, or {a. b. c} dynamic
    expr = (function (s) {
      var out = "", i = 0;
      while (i < s.length) {
        if (s.charAt(i) !== "[") { out += s.charAt(i); i++; continue; }
        var close = findMatching(s, i, "[", "]");
        if (close === -1) { out += s.charAt(i); i++; continue; }
        var inner = s.slice(i + 1, close);
        // Skip Smalltalk-style block syntax produced by the arrow handler.
        // Heuristic: any of these mean "this is a block, not an array literal":
        //   - starts with `:` (block param) or `|` (temps)
        //   - contains `^` (return), `:=` (assignment), or `Transcript`
        //   - contains `;` (cascade) — never legal inside a JS array literal
        //   - contains a Smalltalk keyword message (`word:` followed by space)
        //   - contains a statement separator `. ` followed by content
        if (/^\s*[:|]/.test(inner) ||
            /\^/.test(inner) ||
            /:=/.test(inner) ||
            /;/.test(inner) ||
            /\bTranscript\b/.test(inner) ||
            /\b[a-zA-Z_]\w*:\s/.test(inner) ||
            /\.\s+\S/.test(inner)) {
          out += "[" + inner + "]";
          i = close + 1;
          continue;
        }
        var prevCh = "";
        for (var p = out.length - 1; p >= 0; p--) {
          if (!/\s/.test(out.charAt(p))) { prevCh = out.charAt(p); break; }
        }
        var isSubscript = /[\w\)\]]/.test(prevCh);
        if (isSubscript) {
          // arr[expr] → (arr at: (expr) + 1)
          // Need to remove the receiver from `out` and re-emit it.
          var recvEnd = out.length;
          var recvStart = recvEnd;
          if (prevCh === ")" || prevCh === "]") {
            // bracketed receiver — find matching open
            var openCh = prevCh === ")" ? "(" : "[";
            var depth = 0;
            for (var q = recvEnd - 1; q >= 0; q--) {
              var ch = out.charAt(q);
              if (ch === prevCh) depth++;
              else if (ch === openCh) {
                depth--;
                if (depth === 0) { recvStart = q; break; }
              }
            }
          } else {
            // identifier (possibly with dots)
            recvStart = recvEnd;
            while (recvStart > 0 && /[\w\.]/.test(out.charAt(recvStart - 1))) recvStart--;
          }
          var recv = out.slice(recvStart);
          out = out.slice(0, recvStart);
          var idx = inner.replace(/^\s+|\s+$/g, "");
          if (isNumericLiteral(idx)) {
            out += "(" + recv + " at: " + (parseInt(idx, 10) + 1) + ")";
          } else {
            out += "(" + recv + " at: (" + idx + ") + 1)";
          }
          i = close + 1;
          continue;
        }
        // Array literal
        var parts = splitTopLevel(inner, ",").filter(Boolean);
        if (parts.length === 0) {
          out += "OrderedCollection new";
        } else if (parts.every(isSimpleAtom)) {
          // Squeak literal array: #(1 2 'three' true)
          var lit = parts.map(function (p) {
            var t = p.replace(/^\s+|\s+$/g, "");
            if (t === "true") return "true";
            if (t === "false") return "false";
            if (t === "nil") return "nil";
            return t;
          });
          out += "#(" + lit.join(" ") + ")";
        } else {
          // Dynamic array; convert each element recursively
          var dyn = parts.map(function (p) { return convertExpression(p); });
          out += "{" + dyn.join(". ") + "}";
        }
        i = close + 1;
      }
      return out;
    })(expr);

    // String methods
    expr = expr.replace(/(\w+)\.charAt\(([^)]+)\)/g, "($1 at: ($2 + 1)) asString");
    expr = expr.replace(/(\w+)\.substring\(([^,)]+),\s*([^)]+)\)/g, "$1 copyFrom: ($2 + 1) to: $3");
    expr = expr.replace(/(\w+)\.split\(([^)]+)\)/g, "($1 substrings: $2)");
    expr = expr.replace(/(\w+)\.toUpperCase\(\)/g, "$1 asUppercase");
    expr = expr.replace(/(\w+)\.toLowerCase\(\)/g, "$1 asLowercase");
    expr = expr.replace(/(\w+)\.trim\(\)/g, "$1 trimSeparators");
    expr = expr.replace(/(\w+)\.hasOwnProperty\(([^)]+)\)/g, "$1 includesKey: $2");

    // String concatenation: 'a' + b → 'a' , b   (best-effort: between strings & vars)
    // Only apply when one side is clearly a string literal.
    expr = expr.replace(/('[^']*')\s*\+\s*/g, "$1 , ");
    expr = expr.replace(/\s*\+\s*('[^']*')/g, " , $1");

    // Restore ternary block-bracket sentinels now that the array-literal
    // handler has finished and can no longer mistake them for array syntax.
    expr = expr.replace(/\u0001/g, "[").replace(/\u0002/g, "]");

    return expr;
  }

  // ---------- main converter ----------

  function convert(js, options) {
    options = options || {};
    var indentChar = options.indentChar || "    ";
    var warnings = [];

    // Convert /* block comments */ to Squeak-style "..." comments
    var src = js.replace(/\/\*[\s\S]*?\*\//g, function (m) {
      var lines = m.split("\n");
      return lines.map(function (l) {
        var cleaned = l.replace(/^\/\*\*?/, "")
          .replace(/\*\/$/, "")
          .replace(/^\s*\*\s?/, "")
          .replace(/^\s+|\s+$/g, "");
        return "// " + cleaned;
      }).join("\n");
    });

    var lines = src.split("\n");
    var output = [];

    // Pass 1: collect declared variables for the | temps | block
    var declaredVars = {};
    function declare(name) { if (name) declaredVars[name] = true; }

    for (var i = 0; i < lines.length; i++) {
      var t = lines[i].replace(/^\s+|\s+$/g, "");
      var m;
      if ((m = t.match(/^(?:let|const|var)\s+(\w+)/))) declare(m[1]);
      if (/^(?:let|const|var)\s*\{/.test(t)) {
        var openIdx = t.indexOf("{");
        var closeIdx = findMatching(t, openIdx, "{", "}");
        if (closeIdx !== -1) {
          collectDestructuredNames(t.slice(openIdx + 1, closeIdx)).forEach(declare);
        }
      }
      if ((m = t.match(/^(?:let|const|var)\s*\[([^\]]+)\]/))) {
        m[1].split(",").forEach(function (v) {
          var name = v.split("=")[0].replace(/^\s+|\s+$/g, "");
          if (name && name !== "_") declare(name);
        });
      }
      if ((m = t.match(/^for\s*\(\s*(?:let|const|var)\s+(\w+)/))) declare(m[1]);
    }

    var declared = Object.keys(declaredVars);
    if (declared.length > 0) {
      output.push("| " + declared.join(" ") + " |");
      output.push("");
    }

    // Pass 2: line-by-line conversion
    // Track what kind of construct each `{` opens, so the matching `}` can
    // emit the right closing token (`].` for code blocks, blank for classes).
    var braceStack = [];
    for (var idx = 0; idx < lines.length; idx++) {
      var rawLine = lines[idx];
      var indent = getIndent(rawLine);
      var stripped = stripLineComment(rawLine);
      var lineNoComment = stripped.code;
      var comment = stripped.comment;
      var trimmed = lineNoComment.replace(/^\s+|\s+$/g, "");

      if (!trimmed && !comment) { output.push(""); continue; }
      if (!trimmed && comment) { output.push(indent + '"' + comment + '"'); continue; }

      var transformed = null;
      var match;

      // Variable declarations
      if ((match = trimmed.match(/^(?:let|const|var)\s+(\w+)\s*=\s*([\s\S]+)$/))) {
        var rhs = convertExpression(removeSemicolon(match[2]));
        transformed = indent + match[1] + " := " + rhs + ".";
      }

      // Destructuring object: const {a, b: alias, c = 1, d: {e}} = obj
      // Balanced extraction so nested patterns work.
      if (!transformed && /^(?:let|const|var)\s*\{/.test(trimmed)) {
        var oIdx = trimmed.indexOf("{");
        var cIdx = findMatching(trimmed, oIdx, "{", "}");
        var eqTail = cIdx !== -1 ? trimmed.slice(cIdx + 1).match(/^\s*=\s*([\s\S]+)$/) : null;
        if (cIdx !== -1 && eqTail) {
          var srcExpr = convertExpression(removeSemicolon(eqTail[1]));
          transformed = emitObjectDestructure(trimmed.slice(oIdx + 1, cIdx), srcExpr, indent);
        }
      }

      // Destructuring array: const [a, b, c] = arr
      if (!transformed && (match = trimmed.match(/^(?:let|const|var)\s*\[([^\]]+)\]\s*=\s*([\s\S]+)$/))) {
        var srcExpr2 = convertExpression(removeSemicolon(match[2]));
        var elems = splitTopLevel(match[1], ",");
        var lines3 = elems.map(function (entry, idx2) {
          var parts3 = entry.split("=");
          var name = parts3[0].replace(/^\s+|\s+$/g, "");
          if (!name || name === "_") return null;
          var defaultVal2 = parts3[1] ? convertExpression(parts3[1]) : null;
          if (defaultVal2 !== null) {
            return indent + name + " := (" + srcExpr2 + " at: " + (idx2 + 1) +
              " ifAbsent: [" + defaultVal2 + "]).";
          }
          return indent + name + " := " + srcExpr2 + " at: " + (idx2 + 1) + ".";
        }).filter(Boolean);
        transformed = lines3.join("\n");
      }

      // for (let i = a; i < b; i++)
      if (!transformed && (match = trimmed.match(/^for\s*\(\s*(?:let|const|var)?\s*(\w+)\s*=\s*([^;]+);\s*\1\s*<\s*([^;]+);\s*\1\+\+\s*\)\s*\{?/))) {
        transformed = indent + convertExpression(match[2].replace(/^\s+|\s+$/g, "")) + " to: " +
          convertExpression(match[3].replace(/^\s+|\s+$/g, "")) + " - 1 do: [:" + match[1] + " |";
        if (/\{$/.test(trimmed)) braceStack.push("block");
      }
      // for (let i = a; i <= b; i++)
      if (!transformed && (match = trimmed.match(/^for\s*\(\s*(?:let|const|var)?\s*(\w+)\s*=\s*([^;]+);\s*\1\s*<=\s*([^;]+);\s*\1\+\+\s*\)\s*\{?/))) {
        transformed = indent + convertExpression(match[2].replace(/^\s+|\s+$/g, "")) + " to: " +
          convertExpression(match[3].replace(/^\s+|\s+$/g, "")) + " do: [:" + match[1] + " |";
        if (/\{$/.test(trimmed)) braceStack.push("block");
      }
      // for...of
      if (!transformed && (match = trimmed.match(/^for\s*\(\s*(?:let|const|var)?\s+(\w+)\s+of\s+(\w+)\s*\)\s*\{?/))) {
        transformed = indent + match[2] + " do: [:" + match[1] + " |";
        if (/\{$/.test(trimmed)) braceStack.push("block");
      }
      // for...in
      if (!transformed && (match = trimmed.match(/^for\s*\(\s*(?:let|const|var)?\s+(\w+)\s+in\s+(\w+)\s*\)\s*\{?/))) {
        transformed = indent + match[2] + " keysAndValuesDo: [:" + match[1] + " :value |";
        warnings.push("for...in converted to keysAndValuesDo: - adjust if needed.");
        if (/\{$/.test(trimmed)) braceStack.push("block");
      }

      // Helper: extract a balanced (...) condition after a keyword.
      // Returns { cond, hasBrace } or null if no match.
      function matchControlHeader(line, keyword) {
        var re = new RegExp("^" + keyword + "\\s*\\(");
        var hm = line.match(re);
        if (!hm) return null;
        var openIdx = hm[0].length - 1;
        var closeIdx = findMatching(line, openIdx, "(", ")");
        if (closeIdx === -1) return null;
        var tail = line.slice(closeIdx + 1).replace(/^\s+|\s+$/g, "");
        return {
          cond: line.slice(openIdx + 1, closeIdx),
          hasBrace: /\{$/.test(tail) || tail === "{"
        };
      }

      // while — uses balanced-paren scan so nested `(...)` in the cond works.
      // Guard: when a do-block is open, a bare `while (cond);` is the closer
      // for a no-brace `do ... while (...);`, NOT a new loop. Skip here and
      // let the do-while closer below handle it.
      if (!transformed && braceStack[braceStack.length - 1] !== "do-block") {
        var wh = matchControlHeader(trimmed, "while");
        if (wh) {
          transformed = indent + "[" + convertExpression(wh.cond) + "] whileTrue: [";
          if (wh.hasBrace) braceStack.push("block");
        }
      }
      // do { ... } while (cond)  — full Smalltalk emission target is
      // `[body. (cond)] whileTrue: []`, which runs body once then re-evaluates
      // body+cond on each loop, returning cond as the receiver block's value.
      //
      // Three input shapes are handled:
      //   (a) single-line:  do { body } while (cond);
      //   (b) braced-open:  do {           ← matching `}` closes via `} while (cond);` below
      //   (c) no-brace:     do            ← next stmt is body; matching while is bare
      //
      // For (b) and (c) we push "do-block" so the matching closer below
      // emits `(cond)] whileTrue: [].` instead of the generic `].`.
      if (!transformed && trimmed.match(/^do\b/)) {
        // (a) single-line: `do { body } while (cond);` collapsed onto one line.
        var slMatch = trimmed.match(/^do\s*\{/);
        if (slMatch) {
          var bodyOpen = slMatch[0].length - 1;
          var bodyClose = findMatching(trimmed, bodyOpen, "{", "}");
          if (bodyClose !== -1) {
            var afterBody = trimmed.slice(bodyClose + 1).replace(/^\s+|\s+$/g, "");
            var whMatch = afterBody.match(/^while\s*\(/);
            if (whMatch) {
              var condOpen = whMatch[0].length - 1;
              var condClose = findMatching(afterBody, condOpen, "(", ")");
              if (condClose !== -1) {
                var bodySrc = trimmed.slice(bodyOpen + 1, bodyClose).replace(/^\s+|\s+$/g, "");
                var condSrc = afterBody.slice(condOpen + 1, condClose);
                var bodyStmts = splitTopLevel(bodySrc, ";")
                  .map(function (s) { return s.replace(/^\s+|\s+$/g, ""); })
                  .filter(Boolean)
                  .map(function (s) { return convertExpression(s) + "."; })
                  .join(" ");
                transformed = indent + "[" + bodyStmts + " (" +
                  convertExpression(condSrc) + ")] whileTrue: [].";
                warnings.push("do...while: body runs once then loops while cond. Emitted as [body. (cond)] whileTrue: [] approximation.");
              }
            }
          }
        }
        // (b)/(c): block-open or no-brace form. Always push do-block.
        if (!transformed) {
          transformed = indent + "[";
          warnings.push("do...while: body runs once then loops while cond. Emitted as [body. (cond)] whileTrue: [] approximation.");
          braceStack.push("do-block");
        }
      }
      // } while (cond);  OR  while (cond);  when a do-block is open.
      // Closes the matching `[` and chains `(cond)] whileTrue: [].`. Stack
      // guard requires top === "do-block" so a stray `while (...);` outside a
      // do-block falls through to the regular while-loop handler.
      if (!transformed && /^(?:\}\s*)?while\s*\(/.test(trimmed) &&
          braceStack[braceStack.length - 1] === "do-block") {
        var dwOpen = trimmed.indexOf("(");
        var dwClose = findMatching(trimmed, dwOpen, "(", ")");
        if (dwClose !== -1) {
          var dwCond = trimmed.slice(dwOpen + 1, dwClose);
          braceStack.pop();
          transformed = indent + "(" + convertExpression(dwCond) + ")] whileTrue: [].";
        }
      }
      // if — balanced-paren cond.
      if (!transformed) {
        var ih = matchControlHeader(trimmed, "if");
        if (ih) {
          transformed = indent + "(" + convertExpression(ih.cond) + ") ifTrue: [";
          if (ih.hasBrace) braceStack.push("block");
        }
      }
      // } else if — balanced-paren cond.
      if (!transformed && /^\}\s*else\s+if\s*\(/.test(trimmed)) {
        var eiHead = trimmed.replace(/^\}\s*else\s+/, "");
        var eih = matchControlHeader(eiHead, "if");
        if (eih) {
          transformed = indent + "] ifFalse: [(" + convertExpression(eih.cond) + ") ifTrue: [";
          warnings.push("else if chains may need manual bracket adjustment.");
        }
      }
      // } else
      if (!transformed && trimmed.match(/^\}\s*else\s*\{?/)) {
        transformed = indent + "] ifFalse: [";
      }
      // closing brace — emit based on what the matching `{` opened
      if (!transformed && (trimmed === "}" || trimmed === "};")) {
        var top = braceStack.pop() || "block";
        if (top === "class") {
          // Class body close — emit blank line and skip remaining handlers
          // so the lone `}` does not fall through to expression fallback.
          output.push(indent);
          continue;
        }
        transformed = indent + "].";
      }

      // function declaration — supports async, generator (function* OR function *), and async generators
      if (!transformed && (match = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s*(\*?)\s*(\w+)\s*\(([^)]*)\)\s*\{?/))) {
        var isGen = match[1] === "*";
        var fnName = match[2];
        var hasRest = false;
        var restName = "";
        var params = match[3].split(",")
          .map(function (p) {
            var raw = p.replace(/^\s+|\s+$/g, "").split("=")[0].replace(/^\s+|\s+$/g, "");
            if (/^\.\.\./.test(raw)) {
              hasRest = true;
              restName = raw.replace(/^\.\.\.\s*/, "");
              return restName;
            }
            return raw;
          })
          .filter(Boolean);
        var sig = fnName + (params.length ? ": " + params.join(" and: ") : "");
        transformed = indent + '"Method: ' + sig + '"\n' + indent + sig + "\n" + indent + "[";
        if (hasRest) {
          warnings.push("Function '" + fnName + "' has a rest parameter (..." + restName + ") — Squeak methods take fixed arity; pass an OrderedCollection or Array for '" + restName + "'.");
        }
        if (isGen) {
          warnings.push("Function '" + fnName + "' is a generator (function*) — Squeak has no direct equivalent; consider using Stream or returning an OrderedCollection.");
        } else {
          warnings.push("Function '" + fnName + "' converted as a block - adapt to a proper Squeak method definition if needed.");
        }
        if (/\{$/.test(trimmed)) braceStack.push("block");
      }
      // class declaration — push "class" so closing `}` does NOT emit `].`
      if (!transformed && (match = trimmed.match(/^(?:export\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?\s*\{?/))) {
        var parent = match[2] || "Object";
        transformed = indent + parent + " subclass: #" + match[1] + "\n" +
          indent + indentChar + "instanceVariableNames: ''\n" +
          indent + indentChar + "classVariableNames: ''\n" +
          indent + indentChar + "poolDictionaries: ''\n" +
          indent + indentChar + "category: 'MyCategory'";
        if (/\{$/.test(trimmed)) braceStack.push("class");
      }
      // class member: static method  →  class-side method
      if (!transformed && (match = trimmed.match(/^static\s+(\w+)\s*\(([^)]*)\)\s*\{?/))) {
        var staticParams = match[2].split(",")
          .map(function (p) { return p.replace(/^\s+|\s+$/g, "").split("=")[0].replace(/^\.\.\.\s*/, ""); })
          .filter(Boolean);
        var staticSig = match[1] + (staticParams.length ? ": " + staticParams.join(" and: ") : "");
        transformed = indent + '"Class method: ' + staticSig + '"\n' + indent + "+ " + staticSig + "\n" + indent + "[";
        warnings.push("Static method '" + match[1] + "' converted as class-side method (leading + marker).");
        if (/\{$/.test(trimmed)) braceStack.push("block");
      }
      // class member: getter  →  reader method
      if (!transformed && (match = trimmed.match(/^get\s+(\w+)\s*\(\s*\)\s*\{?/))) {
        transformed = indent + '"Getter: ' + match[1] + '"\n' + indent + match[1] + "\n" + indent + "[";
        if (/\{$/.test(trimmed)) braceStack.push("block");
      }
      // class member: setter  →  writer method (name:)
      if (!transformed && (match = trimmed.match(/^set\s+(\w+)\s*\(\s*(\w+)\s*\)\s*\{?/))) {
        transformed = indent + '"Setter: ' + match[1] + ':"\n' + indent + match[1] + ": " + match[2] + "\n" + indent + "[";
        if (/\{$/.test(trimmed)) braceStack.push("block");
      }
      // yield / yield* — keep output valid Smalltalk; surface as a comment so
      // the user can adapt to a Stream or collection accumulator.
      if (!transformed && (match = trimmed.match(/^yield\s*\*?\s*(.*);?$/))) {
        var yval = match[1] ? convertExpression(removeSemicolon(match[1])) : "nil";
        transformed = indent + '"yield: ' + yval.replace(/"/g, "''") + '" nil.';
      }
      // return — bare `return;` becomes `^nil` (not bare `^`, which is invalid Smalltalk).
      // Strip the trailing `;` BEFORE the truthy check, so `return;` (where the
      // regex captures `;`) is recognized as having no value.
      if (!transformed && (match = trimmed.match(/^return\s*(.*);?$/))) {
        var rawVal = (match[1] || "").replace(/;\s*$/, "").replace(/^\s+|\s+$/g, "");
        var val = rawVal ? convertExpression(rawVal) : "nil";
        transformed = indent + "^" + val;
      }
      // throw
      if (!transformed && (match = trimmed.match(/^throw\s+(?:new\s+)?(\w+)\(([^)]*)\)/))) {
        transformed = indent + match[1] + " signal: " + convertExpression(match[2]) + ".";
      }
      // try / catch / finally
      if (!transformed && trimmed.match(/^try\s*\{?/)) {
        transformed = indent + "[";
        if (/\{$/.test(trimmed)) braceStack.push("block");
      }
      if (!transformed && (match = trimmed.match(/^\}\s*catch\s*\((\w+)\)\s*\{?/))) {
        transformed = indent + "] on: Error do: [:" + match[1] + " |";
        if (/\{$/.test(trimmed)) braceStack.push("block");
      }
      if (!transformed && trimmed.match(/^\}\s*finally\s*\{?/)) {
        transformed = indent + "] ensure: [";
        if (/\{$/.test(trimmed)) braceStack.push("block");
      }

      // Plain assignment
      if (!transformed && (match = trimmed.match(/^(\w+(?:\.\w+)*)\s*=\s*([\s\S]+)$/))) {
        var firstCh = trimmed.charAt(0);
        if ("=!<>".indexOf(firstCh) === -1) {
          var lhs = match[1];
          var rhs2 = match[2];
          if (lhs.indexOf(".") !== -1) {
            var parts = lhs.split(".");
            var obj = parts[0];
            var prop = parts.slice(1).join(".");
            transformed = indent + obj + " at: #" + prop + " put: " + convertExpression(removeSemicolon(rhs2)) + ".";
          } else {
            transformed = indent + lhs + " := " + convertExpression(removeSemicolon(rhs2)) + ".";
          }
        }
      }

      // Fallback: expression statement
      if (!transformed) {
        var ex = convertExpression(removeSemicolon(trimmed));
        transformed = indent + ex + (ex.charAt(ex.length - 1) === "." ? "" : ".");
      }

      if (comment) transformed = transformed + ' "' + comment + '"';
      output.push(transformed);
    }

    return { squeak: output.join("\n"), warnings: warnings };
  }

  return {
    convert: convert,
    convertExpression: convertExpression,
    version: "1.0.0"
  };
}));
