import { dest, src } from "gulp";
import { load } from "js-yaml";
import { obj } from "through2";
import PluginError from "plugin-error";
import type Vinyl from "vinyl";
import type {
  ExtendedMatchType,
  ExtendedTextmateGrammar,
  Pattern,
  TextmateGrammar,
} from "./textmate-grammar";
import { pipeline } from "stream/promises";

/**
 * Replaces all rule references with the match pattern of the referenced rule.
 *
 * @param value Original regex containing rule references.
 * @param replacements Map from rule name to match text.
 * @returns The new regex after replacement.
 */
function replaceReferencesWithStrings(
  value: string,
  replacements: Map<string, string>,
): string {
  let result = value;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const original = result;
    for (const key of Array.from(replacements.keys())) {
      result = result.replace(`(?#${key})`, `(?:${replacements.get(key)})`);
    }
    if (result === original) {
      return result;
    }
  }
}

/**
 * Gather all macro definitions from the document.
 *
 * @param yaml The root of the YAML document.
 * @returns A map from macro name to replacement text.
 */
function gatherMacros<T>(
  yaml: ExtendedTextmateGrammar<T>,
): Map<string, string> {
  const macros = new Map<string, string>();
  for (const key in yaml.macros) {
    macros.set(key, yaml.macros[key]);
  }

  return macros;
}

/**
 * Return the match text to be substituted wherever the specified rule is referenced in a regular
 * expression.
 *
 * @param rule The rule whose match text is to be retrieved.
 * @returns The match text for the rule. This is either the value of the rule's `match` property,
 *  or the disjunction of the match text of all of the other rules `include`d by this rule.
 */
function getNodeMatchText(rule: Pattern): string {
  if (rule.match !== undefined) {
    // For a match string, just use that string as the replacement.
    return rule.match;
  } else if (rule.patterns !== undefined) {
    const patterns: string[] = [];
    // For a list of patterns, use the disjunction of those patterns.
    for (const patternIndex in rule.patterns) {
      const pattern = rule.patterns[patternIndex];
      if (pattern.include !== null) {
        patterns.push(`(?${pattern.include})`);
      }
    }

    return `(?:${patterns.join("|")})`;
  } else {
    return "";
  }
}

/**
 * Generates a map from rule name to match text.
 *
 * @param yaml The root of the YAML document.
 * @returns A map whose keys are the names of rules, and whose values are the corresponding match
 *  text of each rule.
 */
function gatherMatchTextForRules(yaml: TextmateGrammar): Map<string, string> {
  const replacements = new Map<string, string>();
  for (const key in yaml.repository) {
    const node = yaml.repository[key];
    replacements.set(key, getNodeMatchText(node));
  }

  return replacements;
}

/**
 * Invoke the specified callback function on each rule definition in the file.
 *
 * @param yaml The root of the YAML document.
 * @param action Callback to invoke on each rule.
 */
function visitAllRulesInFile<T>(
  yaml: ExtendedTextmateGrammar<T>,
  action: (rule: Pattern<T>) => void,
) {
  visitAllRulesInRuleMap(yaml.patterns, action);
  if (yaml.repository) {
    visitAllRulesInRuleMap(Object.values(yaml.repository), action);
  }
}

/**
 * Invoke the specified callback function on each rule definition in a map or array of rules.
 * For rules that have a `patterns` element defined child rules, the children are included in the
 * visitation.
 *
 * @param ruleMap The map or array of rules to visit.
 * @param action Callback to invoke on each rule.
 */
function visitAllRulesInRuleMap<T>(
  ruleMap: Array<Pattern<T>>,
  action: (rule: Pattern<T>) => void,
) {
  for (const rule of ruleMap) {
    if (typeof rule === "object") {
      action(rule);
      if (rule.patterns !== undefined) {
        visitAllRulesInRuleMap(rule.patterns, action);
      }
    }
  }
}

/**
 * Invoke the specified transformation on all match patterns in the specified rule.
 *
 * @param rule The rule whose matches are to be transformed.
 * @param action The transformation to make on each match pattern.
 */
function visitAllMatchesInRule<T>(rule: Pattern<T>, action: (match: T) => T) {
  for (const key in rule) {
    switch (key) {
      case "begin":
      case "end":
      case "match":
      case "while": {
        const ruleElement = rule[key];

        if (!ruleElement) {
          continue;
        }

        rule[key] = action(ruleElement);
        break;
      }
      default:
        break;
    }
  }
}

/**
 * Replace any usage of the specified `beginPattern` or `endPattern` property with the equivalent
 * `begin`/`beginCaptures` or `end`/`endCaptures` properties.
 *
 * @param rule Rule to be transformed.
 * @param key Base key of the property to be transformed.
 */
function expandPatternMatchProperties<T>(
  rule: Pattern<T>,
  key: "begin" | "end",
) {
  const patternKey = `${key}Pattern` as const;
  const capturesKey = `${key}Captures` as const;
  const pattern = rule[patternKey];
  if (pattern !== undefined) {
    const patterns: string[] = Array.isArray(pattern) ? pattern : [pattern];
    rule[key] = patterns.map((p) => `((?${p}))`).join("|") as T;
    const captures: Pattern["captures"] = {};
    for (const patternIndex in patterns) {
      captures[(Number(patternIndex) + 1).toString()] = {
        patterns: [
          {
            include: patterns[patternIndex],
          },
        ],
      };
    }
    rule[capturesKey] = captures;
    rule[patternKey] = undefined;
  }
}

/**
 * Transform the specified document to produce a TextMate grammar.
 *
 * @param yaml The root of the YAML document.
 */
function transformFile(yaml: ExtendedTextmateGrammar<ExtendedMatchType>) {
  const macros = gatherMacros(yaml);
  visitAllRulesInFile(yaml, (rule) => {
    expandPatternMatchProperties(rule, "begin");
    expandPatternMatchProperties(rule, "end");
  });

  // Expand macros in matches.
  visitAllRulesInFile(yaml, (rule) => {
    visitAllMatchesInRule(rule, (match) => {
      if (typeof match === "object") {
        for (const key in match) {
          return macros.get(key)!.replace("(?#)", `(?:${match[key]})`);
        }
        throw new Error("No key in macro map.");
      } else {
        return match;
      }
    });
  });

  yaml.macros = undefined;

  // We have removed all object match properties, so we don't have an extended match type anymore.
  const macrolessYaml = yaml as ExtendedTextmateGrammar;

  const replacements = gatherMatchTextForRules(macrolessYaml);
  // Expand references in matches.
  visitAllRulesInFile(macrolessYaml, (rule) => {
    visitAllMatchesInRule(rule, (match) => {
      return replaceReferencesWithStrings(match, replacements);
    });
  });

  if (macrolessYaml.regexOptions !== undefined) {
    const regexOptions = `(?${macrolessYaml.regexOptions})`;
    visitAllRulesInFile(macrolessYaml, (rule) => {
      visitAllMatchesInRule(rule, (match) => {
        return regexOptions + match;
      });
    });

    macrolessYaml.regexOptions = undefined;
  }

  return macrolessYaml;
}

export function transpileTextMateGrammar() {
  return obj(
    (
      file: Vinyl,
      _encoding: string,
      callback: (err: string | null, file: Vinyl | PluginError) => void,
    ): void => {
      if (file.isNull()) {
        callback(null, file);
      } else if (file.isBuffer()) {
        const buf: Buffer = file.contents;
        const yamlText: string = buf.toString("utf8");
        const yamlData = load(yamlText) as TextmateGrammar;
        const jsonData = transformFile(yamlData);

        file.contents = Buffer.from(JSON.stringify(jsonData, null, 2), "utf8");
        file.extname = ".json";
        callback(null, file);
      } else {
        callback(
          "error",
          new PluginError("transpileTextMateGrammar", "Format not supported."),
        );
      }
    },
  );
}

export function compileTextMateGrammar() {
  return pipeline(
    src("syntaxes/*.tmLanguage.yml"),
    transpileTextMateGrammar(),
    dest("out/syntaxes"),
  );
}
