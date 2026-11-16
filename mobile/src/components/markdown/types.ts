// Adapted from EvanBacon/chat-template (MIT)
/**
 * Types of the markdown renderer: one render rule per mdast node type, a
 * style per rule.
 */
import type { Node, Root, RootContentMap } from 'mdast';
import type { ReactNode } from 'react';
import type { ImageStyle, StyleProp, TextStyle, ViewStyle } from 'react-native';

type NamedStyle = StyleProp<ViewStyle | TextStyle | ImageStyle>;
export type StyleMap = Record<string, NamedStyle>;

type Prettify<T> = { [K in keyof T]: T[K] } & {};

type BaseNodeKeys = {
  [K in keyof RootContentMap]: RootContentMap[K] extends Node ? K : never;
}[keyof RootContentMap];

export type ValidNodeKey = BaseNodeKeys | 'unknown' | 'root';

export type NodeTypeMap = Prettify<
  { [K in BaseNodeKeys]: RootContentMap[K] } & { unknown: Node; root: Root }
>;

/** What a list item or table cell learns from its parent. */
export interface RenderExtras {
  listStyleType?: string;
  ordered?: boolean;
  index?: number;
  isHeader?: boolean;
  cellIndex?: number;
}

export type RenderFunction<K extends ValidNodeKey = ValidNodeKey> = (params: {
  node: NodeTypeMap[K] & { key?: string };
  styles: StyleMap;
  children: ReactNode[];
  parentStack: Node[];
  extras?: RenderExtras;
}) => ReactNode;

export type RenderRules = {
  [K in ValidNodeKey]?: RenderFunction<K>;
};

export interface ASTRendererOptions {
  renderRules?: RenderRules;
  styles?: StyleMap | null;
  mergeStyle?: boolean;
}

export interface MarkdownProps extends ASTRendererOptions {
  markdown: string;
}
