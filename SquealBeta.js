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

  function convertStringLiteral(jsStr) {
    var first = jsStr.charAt(0);
    var inner = jsStr.slice(1, -1);

    if (first === "`") {
      inner = inner.replace(/\$\{([^}]+)\}/g, "' , ($1) printString , '");
      return "'" + inner.replace(/'/g, "''") + "'";
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

    // String literals first (so subsequent regex doesn't mangle them)
    expr = expr.replace(/(`[^`]*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, function (m) {
      return convertStringLiteral(m);
    });

    // console.log / error / warn → Transcript showCrLf:
    expr = expr.replace(/console\.(?:log|error|warn|info)\s*\(([^)]*)\)/g, function (_m, args) {
      var parts = args.split(",").map(function (a) { return a.replace(/^\s+|\s+$/g, ""); });
      var pieces = parts.map(function (a) { return a + " printString"; });
      return "Transcript showCrLf: " + pieces.join(", ' ', ");
    });

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

    // Arrow functions
    expr = expr.replace(/\(([^)]*)\)\s*=>\s*\{([^}]*)\}/g, function (_m, p, b) {
      var params = p.split(",").map(function (x) { return x.replace(/^\s+|\s+$/g, ""); }).filter(Boolean);
      var pl = params.map(function (x) { return ":" + x; }).join(" ");
      return "[" + pl + (pl ? " | " : "") + b.replace(/^\s+|\s+$/g, "") + " ]";
    });
    expr = expr.replace(/\(([^)]*)\)\s*=>\s*([^,\n]+)/g, function (_m, p, b) {
      var params = p.split(",").map(function (x) { return x.replace(/^\s+|\s+$/g, ""); }).filter(Boolean);
      var pl = params.map(function (x) { return ":" + x; }).join(" ");
      return "[" + pl + (pl ? " | " : "") + b.replace(/^\s+|\s+$/g, "") + " ]";
    });
    expr = expr.replace(/(\w+)\s*=>\s*([^,\n]+)/g, function (_m, p, b) {
      return "[:" + p + " | " + b.replace(/^\s+|\s+$/g, "") + " ]";
    });

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

    // Array literals
    expr = expr.replace(/\[(\s*\d+(?:\s*,\s*\d+)*\s*)\]/g, function (_m, nums) {
      return "#(" + nums.replace(/,/g, "") + ")";
    });
    expr = expr.replace(/\[([^\]]+)\]/g, function (_m, items) {
      var parts = items.split(",").map(function (i) { return i.replace(/^\s+|\s+$/g, ""); }).filter(Boolean);
      if (parts.length === 0) return "OrderedCollection new";
      return "(OrderedCollection withAll: {" + parts.join(". ") + "})";
    });

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
        m[1].split(",").forEach(function (v) { declare(v.split(":")[0].replace(/^\s+|\s+$/g, "")); });
      }
      if ((m = t.match(/^(?:let|const|var)\s*\[([^\]]+)\]/))) {
        m[1].split(",").forEach(function (v) { declare(v.replace(/=.*/, "").replace(/^\s+|\s+$/g, "")); });
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

      // Destructuring object: const {a, b} = obj
      if (!transformed && (match = trimmed.match(/^(?:let|const|var)\s*\{([^}]+)\}\s*=\s*(\w+)/))) {
        var vars = match[1].split(",").map(function (v) { return v.split(":")[0].replace(/^\s+|\s+$/g, ""); });
        var srcVar = match[2];
        transformed = vars.map(function (v) {
          return indent + v + " := " + srcVar + " at: '" + v + "'.";
        }).join("\n");
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
