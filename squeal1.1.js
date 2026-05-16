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
    // Skip rewrites inside Smalltalk strings (single-quoted).
    expr = mapOutsideStrings(expr, function (chunk) {
      return chunk
        .replace(/\basync\s+/g, "")
        .replace(/\bawait\s+/g, "");
    });

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
    expr = expr.replace(/typeof\s+(\w+)\s*===?\s*'(\w+)'/g, function (_m, v, t) {
      var typeMap = {
        string: "String", number: "Number", boolean: "Boolean",
        object: "Object", "function": "BlockClosure", undefined: "UndefinedObject"
      };
      return v + " isKindOf: " + (typeMap[t] || t);
    });

    // null / undefined → nil
    expr = expr.replace(/\bnull\b/g, "nil").replace(/\bundefined\b/g, "nil");

    // ++ / --
    expr = expr.replace(/(\w+)\+\+/g, "$1 := $1 + 1");
    expr = expr.replace(/(\w+)--/g, "$1 := $1 - 1");
    expr = expr.replace(/\+\+(\w+)/g, "$1 := $1 + 1");
    expr = expr.replace(/--(\w+)/g, "$1 := $1 - 1");

    // Compound assigns
    expr = expr.replace(/(\w+)\s*\+=\s*(.+)/, "$1 := $1 + $2");
    expr = expr.replace(/(\w+)\s*-=\s*(.+)/, "$1 := $1 - $2");
    expr = expr.replace(/(\w+)\s*\*=\s*(.+)/, "$1 := $1 * $2");
    expr = expr.replace(/(\w+)\s*\/=\s*(.+)/, "$1 := $1 / $2");

    // Comparison and logical operators
    expr = expr.replace(/===/g, "=");
    expr = expr.replace(/!==/g, "~=");
    expr = expr.replace(/==/g, "=");
    expr = expr.replace(/!=/g, "~=");
    expr = expr.replace(/&&/g, " & ");
    expr = expr.replace(/\|\|/g, " | ");
    expr = expr.replace(/!(\w+)/g, "$1 not");

    // Modulo: a % b → a \\ b   (Smalltalk uses \\ for modulo)
    expr = expr.replace(/(\w+|\))\s*%\s*(\w+|\()/g, "$1 \\\\ $2");

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

    // Array.isArray
    expr = expr.replace(/Array\.isArray\((\w+)\)/g, "$1 isKindOf: Array");

    // Array / collection methods
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
    expr = expr.replace(/(\w+)\.map\(([^)]+)\)/g, "$1 collect: $2");
    expr = expr.replace(/(\w+)\.filter\(([^)]+)\)/g, "$1 select: $2");
    expr = expr.replace(/(\w+)\.forEach\(([^)]+)\)/g, "$1 do: $2");
    expr = expr.replace(/(\w+)\.find\(([^)]+)\)/g, "$1 detect: $2");
    expr = expr.replace(/(\w+)\.reduce\(([^,)]+),\s*([^)]+)\)/g, "$1 inject: $3 into: $2");
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
      if ((m = t.match(/^(?:let|const|var)\s*\{([^}]+)\}/))) {
        m[1].split(",").forEach(function (v) {
          var afterColon = v.indexOf(":") !== -1 ? v.split(":")[1] : v;
          declare(afterColon.split("=")[0].replace(/^\s+|\s+$/g, ""));
        });
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

      // Destructuring object: const {a, b: alias, c = 1} = obj
      if (!transformed && (match = trimmed.match(/^(?:let|const|var)\s*\{([^}]+)\}\s*=\s*([\s\S]+)$/))) {
        var srcExpr = convertExpression(removeSemicolon(match[2]));
        var lines2 = splitTopLevel(match[1], ",").map(function (entry) {
          entry = entry.replace(/^\s+|\s+$/g, "");
          var colonIdx = entry.indexOf(":");
          var key, rest;
          if (colonIdx !== -1) {
            key = entry.slice(0, colonIdx).replace(/^\s+|\s+$/g, "");
            rest = entry.slice(colonIdx + 1).replace(/^\s+|\s+$/g, "");
          } else {
            // shorthand `key` or `key = default` — key is up to `=` or whole entry
            var eqIdx = entry.indexOf("=");
            key = (eqIdx !== -1 ? entry.slice(0, eqIdx) : entry).replace(/^\s+|\s+$/g, "");
            rest = entry;
          }
          var defaultParts = rest.split("=");
          var localName = defaultParts[0].replace(/^\s+|\s+$/g, "");
          var defaultVal = defaultParts[1] ? convertExpression(defaultParts.slice(1).join("=")) : null;
          if (defaultVal !== null) {
            return indent + localName + " := (" + srcExpr + " at: #" + key +
              " ifAbsent: [" + defaultVal + "]).";
          }
          return indent + localName + " := " + srcExpr + " at: #" + key + ".";
        });
        transformed = lines2.join("\n");
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
      }
      // for (let i = a; i <= b; i++)
      if (!transformed && (match = trimmed.match(/^for\s*\(\s*(?:let|const|var)?\s*(\w+)\s*=\s*([^;]+);\s*\1\s*<=\s*([^;]+);\s*\1\+\+\s*\)\s*\{?/))) {
        transformed = indent + convertExpression(match[2].replace(/^\s+|\s+$/g, "")) + " to: " +
          convertExpression(match[3].replace(/^\s+|\s+$/g, "")) + " do: [:" + match[1] + " |";
      }
      // for...of
      if (!transformed && (match = trimmed.match(/^for\s*\(\s*(?:let|const|var)?\s+(\w+)\s+of\s+(\w+)\s*\)\s*\{?/))) {
        transformed = indent + match[2] + " do: [:" + match[1] + " |";
      }
      // for...in
      if (!transformed && (match = trimmed.match(/^for\s*\(\s*(?:let|const|var)?\s+(\w+)\s+in\s+(\w+)\s*\)\s*\{?/))) {
        transformed = indent + match[2] + " keysAndValuesDo: [:" + match[1] + " :value |";
        warnings.push("for...in converted to keysAndValuesDo: - adjust if needed.");
      }

      // while
      if (!transformed && (match = trimmed.match(/^while\s*\(([^)]+)\)\s*\{?/))) {
        transformed = indent + "[" + convertExpression(match[1]) + "] whileTrue: [";
      }
      // do { ... } while (cond)
      if (!transformed && trimmed.match(/^do\s*\{?/)) {
        transformed = indent + "[";
        warnings.push("do...while converted to whileTrue: block - check closing ].");
      }
      // if
      if (!transformed && (match = trimmed.match(/^if\s*\(([^)]+)\)\s*\{?/))) {
        transformed = indent + "(" + convertExpression(match[1]) + ") ifTrue: [";
      }
      // } else if
      if (!transformed && (match = trimmed.match(/^\}\s*else\s+if\s*\(([^)]+)\)\s*\{?/))) {
        transformed = indent + "] ifFalse: [(" + convertExpression(match[1]) + ") ifTrue: [";
        warnings.push("else if chains may need manual bracket adjustment.");
      }
      // } else
      if (!transformed && trimmed.match(/^\}\s*else\s*\{?/)) {
        transformed = indent + "] ifFalse: [";
      }
      // closing brace
      if (!transformed && (trimmed === "}" || trimmed === "};")) {
        transformed = indent + "].";
      }

      // function declaration
      if (!transformed && (match = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)\s*\{?/))) {
        var fnName = match[1];
        var params = match[2].split(",")
          .map(function (p) { return p.replace(/^\s+|\s+$/g, "").split("=")[0].replace(/^\s+|\s+$/g, ""); })
          .filter(Boolean);
        var sig = fnName + (params.length ? ": " + params.join(" and: ") : "");
        transformed = indent + '"Method: ' + sig + '"\n' + indent + sig + "\n" + indent + "[";
        warnings.push("Function '" + fnName + "' converted as a block - adapt to a proper Squeak method definition if needed.");
      }
      // class declaration
      if (!transformed && (match = trimmed.match(/^(?:export\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?\s*\{?/))) {
        var parent = match[2] || "Object";
        transformed = indent + parent + " subclass: #" + match[1] + "\n" +
          indent + indentChar + "instanceVariableNames: ''\n" +
          indent + indentChar + "classVariableNames: ''\n" +
          indent + indentChar + "poolDictionaries: ''\n" +
          indent + indentChar + "category: 'MyCategory'";
      }
      // return
      if (!transformed && (match = trimmed.match(/^return\s*(.*);?$/))) {
        var val = match[1] ? convertExpression(removeSemicolon(match[1])) : "";
        transformed = indent + "^" + val;
      }
      // throw
      if (!transformed && (match = trimmed.match(/^throw\s+(?:new\s+)?(\w+)\(([^)]*)\)/))) {
        transformed = indent + match[1] + " signal: " + convertExpression(match[2]) + ".";
      }
      // try / catch / finally
      if (!transformed && trimmed.match(/^try\s*\{?/)) transformed = indent + "[";
      if (!transformed && (match = trimmed.match(/^\}\s*catch\s*\((\w+)\)\s*\{?/))) {
        transformed = indent + "] on: Error do: [:" + match[1] + " |";
      }
      if (!transformed && trimmed.match(/^\}\s*finally\s*\{?/)) transformed = indent + "] ensure: [";

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
