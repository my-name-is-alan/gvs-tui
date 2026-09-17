import { expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@vue/compiler-sfc'

// These layout/FFI properties accept numeric values (some also allow "auto"
// or percentages), never a bare numeric string such as flexGrow="1".
const numericProps = new Set([
  'flexgrow', 'flexshrink', 'flexbasis', 'aspectratio', 'gap', 'rowgap', 'columngap',
  'width', 'height', 'minwidth', 'minheight', 'maxwidth', 'maxheight', 'zindex',
  'top', 'right', 'bottom', 'left', 'padding', 'paddingx', 'paddingy', 'paddingtop',
  'paddingright', 'paddingbottom', 'paddingleft', 'margin', 'marginx', 'marginy',
  'margintop', 'marginright', 'marginbottom', 'marginleft', 'opacity',
])

function numericStringProps(source: string, filename = 'fixture.vue'): string[] {
  const { descriptor, errors } = parse(source, { filename })
  if (errors.length) throw new Error(`${filename}: ${errors.map(e => typeof e === 'string' ? e : e.message).join('; ')}`)
  const failures: string[] = []
  type Node = { type: number; tag?: string; children?: Node[]; props?: Array<{
    type: number; name: string; value?: { content: string }; loc: { start: { line: number } }
  }> }
  const visit = (node: Node) => {
    for (const prop of node.props ?? []) {
      // ATTRIBUTE=6; v-bind directives are typed expressions, not strings.
      if (prop.type === 6 && numericProps.has(prop.name.replaceAll('-', '').toLowerCase())
        && prop.value && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(prop.value.content.trim())) {
        failures.push(`${filename}:${prop.loc.start.line} <${node.tag}> ${prop.name}="${prop.value.content}" must use v-bind`)
      }
    }
    for (const child of node.children ?? []) visit(child)
  }
  if (descriptor.template?.ast) visit(descriptor.template.ast as Node)
  return failures
}

test('all Vue templates bind numeric layout props before they reach native FFI', () => {
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? walk(path) : entry.name.endsWith('.vue') ? [path] : []
  })
  const files = walk(join(import.meta.dir, '..'))
  expect(files.length).toBeGreaterThan(0)
  expect(files.flatMap(file => numericStringProps(readFileSync(file, 'utf8'), file))).toEqual([])
})

test('the template guard detects camel/kebab names and fractional numeric strings', () => {
  expect(numericStringProps('<template><Box flexGrow="1"><Box flex-shrink="0" :width="80" padding="0.5" /></Box></template>')).toHaveLength(3)
})

test('valid numeric bindings, percent/auto sizing and text content remain allowed', () => {
  expect(numericStringProps('<template><!-- flexGrow="1" --><Box :flexGrow="1" v-bind:flex-shrink="0" width="100%" height="auto"><Text content="123" /></Box></template>')).toEqual([])
})
