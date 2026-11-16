// Adapted from EvanBacon/chat-template (MIT)
/**
 * Walks an mdast tree and calls a render rule per node, children first.
 * Lists tell their items their marker ("•", "3."), tables tell rows and
 * cells whether they are the header. Deeper than `DEPTH_MAX` a node is
 * drawn as its plain text, so a hostile message can't recurse forever.
 */
import type { List, Node, Root, Table, TableRow } from 'mdast';
import type { ReactNode } from 'react';
import { DEPTH_MAX } from './parse';
import defaultRenderRules from './render-rules';
import type {
  ASTRendererOptions,
  NodeTypeMap,
  RenderExtras,
  RenderFunction,
  RenderRules,
  StyleMap,
  ValidNodeKey,
} from './types';
import { getMergedStyles } from './utils';

const BULLET = '•';

export default class ASTRenderer {
  private rules: RenderRules;
  private styles: StyleMap;

  constructor({
    renderRules,
    styles = null,
    mergeStyle = true,
  }: ASTRendererOptions) {
    this.rules = { ...defaultRenderRules, ...(renderRules ?? {}) };
    this.styles = getMergedStyles(styles, mergeStyle);
  }

  private rule(type: string): RenderFunction {
    const fn = this.rules[type as ValidNodeKey] ?? this.rules.unknown;
    return (fn ?? (() => null)) as RenderFunction;
  }

  private renderNode = (
    node: Node,
    parentStack: Node[] = [],
    extras?: RenderExtras,
  ): ReactNode => {
    if (parentStack.length > DEPTH_MAX) {
      return this.rule('unknown')({
        node: node as NodeTypeMap['unknown'],
        styles: this.styles,
        children: [],
        parentStack,
      });
    }
    const children: ReactNode[] = [];
    const stack = [node, ...parentStack];
    if (node.type === 'list') {
      const list = node as List;
      const start = list.start ?? 1;
      const ordered = !!list.ordered;
      list.children.forEach((item, i) => {
        children.push(
          this.renderNode(item, stack, {
            listStyleType: ordered ? `${start + i}.` : BULLET,
            index: i,
            ordered,
          }),
        );
      });
    } else if (node.type === 'table') {
      (node as Table).children.forEach((row, i) => {
        children.push(this.renderNode(row, stack, { isHeader: i === 0 }));
      });
    } else if (node.type === 'tableRow') {
      (node as TableRow).children.forEach((cell, i) => {
        children.push(
          this.renderNode(cell, stack, { ...extras, cellIndex: i }),
        );
      });
    } else if ('children' in node && Array.isArray(node.children)) {
      for (const child of node.children as Node[]) {
        children.push(this.renderNode(child, stack));
      }
    }
    return this.rule(node.type)({
      node: node as NodeTypeMap[ValidNodeKey],
      styles: this.styles,
      children,
      parentStack,
      extras,
    });
  };

  public render = (tree: Root): ReactNode => this.renderNode(tree);
}
