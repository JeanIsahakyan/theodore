// Adapted from EvanBacon/chat-template (MIT)
/**
 * A render rule per mdast node. Changed from the template for fleet text,
 * which is untrusted (another device wrote it):
 *
 * | Node | Template | Here |
 * | --- | --- | --- |
 * | link | opens the URL | its words, then the address in muted text; nothing opens |
 * | inline code | text | text; in a space's chat a file path opens the viewer (`read_file` to the host) |
 * | image | loads it | `[image: alt]`; nothing loads |
 * | raw HTML | (warned, dropped) | shown as text |
 * | anything else / too deep | (warned, dropped) | its plain text |
 */
import type { Node } from 'mdast';
import { Text, View, type TextStyle, type ViewStyle } from 'react-native';
import { InlineCode } from '../chat/file-link';
import { CodeBlock } from './code-block';
import { linkNote, plainText } from './parse';
import type { RenderRules, StyleMap } from './types';

/** Text selects as DOM text on the web; on the phone a long press on the
 *  message opens Copy / Select text instead (`chat/long-press.tsx`). */
const selectable = process.env.EXPO_OS === 'web';

const view = (styles: StyleMap, key: string) =>
  styles[`_VIEW_SAFE_${key}`] as ViewStyle | undefined;
const text = (styles: StyleMap, key: string) =>
  styles[key] as TextStyle | undefined;
const keyOf = (node: Node) => node.data?.key;

const renderRules: RenderRules = {
  root: ({ node, styles, children }) => (
    <View key={keyOf(node)} style={view(styles, 'root')}>
      {children}
    </View>
  ),
  paragraph: ({ node, styles, children }) => (
    <Text
      key={keyOf(node)}
      selectable={selectable}
      style={[text(styles, 'text'), text(styles, 'paragraph')]}
    >
      {children}
    </Text>
  ),
  heading: ({ node, styles, children }) => (
    <Text
      key={keyOf(node)}
      selectable={selectable}
      accessibilityRole="header"
      style={[text(styles, 'text'), text(styles, `heading${node.depth}`)]}
    >
      {children}
    </Text>
  ),
  strong: ({ node, styles, children }) => (
    <Text key={keyOf(node)} style={text(styles, 'strong')}>
      {children}
    </Text>
  ),
  emphasis: ({ node, styles, children }) => (
    <Text key={keyOf(node)} style={text(styles, 'emphasis')}>
      {children}
    </Text>
  ),
  delete: ({ node, styles, children }) => (
    <Text key={keyOf(node)} style={text(styles, 'delete')}>
      {children}
    </Text>
  ),
  text: ({ node }) => node.value,
  break: ({ node }) => <Text key={keyOf(node)}>{'\n'}</Text>,
  // In a space's chat a file path is a tap to the viewer (`file-link.tsx`).
  inlineCode: ({ node, styles }) => (
    <InlineCode
      key={keyOf(node)}
      value={node.value}
      style={text(styles, 'inlineCode')}
    />
  ),
  code: ({ node, styles }) => (
    <CodeBlock
      key={keyOf(node)}
      code={node.value}
      language={node.lang}
      textStyle={text(styles, 'codeText')}
    />
  ),
  blockquote: ({ node, styles, children }) => (
    <View key={keyOf(node)} style={view(styles, 'blockquote')}>
      {children}
    </View>
  ),
  thematicBreak: ({ node, styles }) => (
    <View key={keyOf(node)} style={view(styles, 'thematicBreak')} />
  ),
  link: ({ node, styles, children }) => {
    const note = linkNote(plainText(node), node.url);
    return (
      <Text key={keyOf(node)} style={text(styles, 'link')}>
        {children}
        {note ? (
          <Text style={text(styles, 'linkNote')}>{` (${note})`}</Text>
        ) : null}
      </Text>
    );
  },
  linkReference: ({ node, children }) => (
    <Text key={keyOf(node)}>{children}</Text>
  ),
  image: ({ node, styles }) => (
    <Text key={keyOf(node)} style={text(styles, 'linkNote')}>
      {`[image${node.alt ? `: ${node.alt}` : ''}]`}
    </Text>
  ),
  imageReference: ({ node, styles }) => (
    <Text key={keyOf(node)} style={text(styles, 'linkNote')}>
      {`[image${node.alt ? `: ${node.alt}` : ''}]`}
    </Text>
  ),
  html: ({ node, styles }) => (
    <Text
      key={keyOf(node)}
      selectable={selectable}
      style={text(styles, 'text')}
    >
      {node.value}
    </Text>
  ),
  list: ({ node, styles, children }) => (
    <View key={keyOf(node)} style={view(styles, 'list')}>
      {children}
    </View>
  ),
  listItem: ({ node, styles, children, extras }) => (
    <View key={keyOf(node)} style={view(styles, 'listItem')}>
      <Text
        style={[
          text(styles, 'text'),
          text(styles, 'listBullet'),
          extras?.ordered ? text(styles, 'orderedBullet') : null,
        ]}
      >
        {extras?.listStyleType}
      </Text>
      <View style={view(styles, 'listItemContent')}>{children}</View>
    </View>
  ),
  table: ({ node, styles, children }) => (
    <View key={keyOf(node)} style={view(styles, 'table')}>
      {children}
    </View>
  ),
  tableRow: ({ node, styles, children, extras }) => (
    <View
      key={keyOf(node)}
      style={[
        view(styles, 'tableRow'),
        extras?.isHeader ? view(styles, 'tableHeaderRow') : null,
      ]}
    >
      {children}
    </View>
  ),
  tableCell: ({ node, styles, children, extras }) => (
    <View
      key={keyOf(node)}
      style={[
        view(styles, 'tableCell'),
        extras?.isHeader ? view(styles, 'tableHeaderCell') : null,
      ]}
    >
      <Text
        selectable={selectable}
        style={[
          text(styles, 'text'),
          text(styles, 'tableCellText'),
          extras?.isHeader ? text(styles, 'tableHeaderCellText') : null,
        ]}
      >
        {children}
      </Text>
    </View>
  ),
  // A node the rules don't know, or one nested too deep: its words.
  unknown: ({ node, styles }) => {
    const words = plainText(node);
    return words ? (
      <Text
        key={keyOf(node)}
        selectable={selectable}
        style={text(styles, 'text')}
      >
        {words}
      </Text>
    ) : null;
  },
};

export default renderRules;
