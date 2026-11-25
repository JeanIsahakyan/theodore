// Adapted from EvanBacon/chat-template (MIT)
/**
 * The drawer (native) and the sidebar (web): Theodore's "chats" are its
 * spaces.
 *
 * ```text
 * Theodore
 * [⌕ Search spaces            ]
 * Today
 *   Fix the login redirect   ●      ● running (accent) / waiting (warning) / failed (red)
 *   3 sub-spaces, 1 running          its sub-spaces, when it has any
 * Yesterday · Previous 7 days · Older
 * On your computers                 the trusted computers' other spaces
 *   Port the parser · mac-A  ●       ─▶ the sub-space screen (read_space)
 * ──────────────────────────────
 * ▢ Devices
 * (JI) Jean · Acme         ⇅  ⚙     account row ─▶ the Accounts sheet (switch
 * ```                                account or org, add one, sign out); ⚙ ─▶ Settings
 *
 * No "New space" row: the ✎ button in the main header, on Home and every
 * space, is the one way to start one.
 *
 * Archive (docs/mobile.md "Archive"; items: `spaceMenuItems` in
 * src/ui/spaceMenu.ts): a long press on a row (iOS / Android), a right-click
 * or its ⋯ (web) opens the platform's context menu (`SpaceMenu`,
 * space-menu{.ios,.android,}.tsx) with Archive, which runs `useArchive`
 * (confirm, stop first if running, archive, toast with Undo). Rows of spaces
 * this phone can't archive have no menu.
 *
 * Pull down to refresh: the cloud's list of this device's spaces again
 * (`list_my_spaces`) and each trusted computer's own (`list_spaces`).
 *
 * Before this run's first devices list (src/ui/load.ts) an empty list is
 * skeleton rows, not "Spaces you start or follow show here."; the server
 * unreachable ─▶ "Can't reach the server" and Retry under the list (saved
 * or empty).
 *
 * iOS: grouped-list look (10 pt rounded highlight). Android: Material 3
 * navigation drawer items (full pill, 56 dp, the active one tinted).
 */
import { usePathname, type Href } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { ComputerSpaceView, SpaceView } from '../fleet/types';
import { useServices } from '../services';
import { useAuthState } from '../shell/AppProviders';
import { spaceHref, subSpaceHref } from '../shell/navigate';
import { useFleetState } from '../state/fleet';
import {
  computerSections,
  computerSpaceDot,
  initials,
  spaceDot,
  spaceSections,
  type SpaceDot,
} from '../ui/drawer';
import { useAccounts } from './accounts/use-accounts';
import { useSheet } from './pickers/sheet-host';
import { UNREACHABLE_TITLE } from '../ui/load';
import { spaceTitle } from '../ui/logic';
import { Button } from '../ui/native';
import { SkeletonRows } from '../ui/Skeleton';
import {
  runSpaceMenuItem,
  spaceMenuItems,
  type SpaceMenuItemId,
} from '../ui/spaceMenu';
import { subSpaceSummary } from '../ui/subSpaceTree';
import { usePalette } from '../ui/theme';
import { useArchive } from '../ui/useArchive';
import { useLoadState } from '../ui/useLoadState';
import { SpaceMenu } from './space-menu';
import { SymbolImage, type SymbolName } from './symbol-image';
import { SafeAreaView } from './tw';

const android = process.env.EXPO_OS === 'android';
const web = process.env.EXPO_OS === 'web';

const DOT_CLASS: Record<SpaceDot, string> = {
  running: 'bg-primary',
  waiting: 'bg-warning',
  failed: 'bg-danger',
};

const DOT_LABEL: Record<SpaceDot, string> = {
  running: 'running',
  waiting: 'waiting for you',
  failed: 'failed',
};

/** The organization's name, once the cloud says it. */
function useOrganizationName(): string | null {
  const { auth } = useServices();
  const { session } = useAuthState();
  const org = session?.organizationId ?? null;
  const [found, setFound] = useState<{ org: string; name: string } | null>(
    null,
  );
  useEffect(() => {
    let live = true;
    if (!org) return undefined;
    auth
      .organizations()
      .then((list) => {
        const name = list.find((o) => o.id === org)?.name;
        if (live && name) setFound({ org, name });
      })
      .catch(() => {
        // the line shows the account alone
      });
    return () => {
      live = false;
    };
  }, [auth, org]);
  return found && found.org === org ? found.name : null;
}

/** Now, moved on every minute: "Today" turns into "Yesterday" at midnight. */
function useMinute(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function NavItem({
  label,
  icon,
  active,
  onPress,
  testID,
}: {
  label: string;
  icon: SymbolName;
  active?: boolean;
  onPress: () => void;
  testID?: string;
}) {
  const p = usePalette();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: !!active }}
      testID={testID}
      android_ripple={{ color: p.border }}
      className={
        android
          ? `mx-3 h-14 flex-row items-center gap-3 overflow-hidden rounded-full px-4 ${active ? 'bg-primary/15' : ''}`
          : `mx-2 flex-row items-center gap-3 rounded-[10px] px-4 py-3 active:bg-muted ${active ? 'bg-muted' : ''}`
      }
    >
      <SymbolImage name={icon} size={android ? 24 : 20} color={p.text} />
      <Text
        className={`text-base text-foreground ${active ? 'font-semibold' : ''}`}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function SpaceItem({
  space,
  active,
  onPress,
  onMenu,
}: {
  space: SpaceView;
  active: boolean;
  onPress: () => void;
  /** An item of the row's menu was chosen. */
  onMenu: (id: SpaceMenuItemId) => void;
}) {
  const p = usePalette();
  const devices = useFleetState((s) => s.devices);
  const subs = useFleetState((s) => s.mirrors[space.space]?.subSpaces);
  const summary = useMemo(() => subSpaceSummary(subs), [subs]);
  const items = useMemo(() => spaceMenuItems(space, devices), [space, devices]);
  const [hovered, setHovered] = useState(false);
  const dot = spaceDot(space);
  const title = spaceTitle(space) || 'Untitled space';
  const label = [title, dot ? DOT_LABEL[dot] : null, summary]
    .filter(Boolean)
    .join(', ');
  return (
    <SpaceMenu
      title={title}
      items={items}
      onSelect={onMenu}
      revealed={hovered || active}
      testID={`space-menu-${space.space}`}
    >
      {({ onLongPress, trailing }) => (
        <Pressable
          onPress={onPress}
          onLongPress={onLongPress}
          onHoverIn={web ? () => setHovered(true) : undefined}
          onHoverOut={web ? () => setHovered(false) : undefined}
          onFocus={web ? () => setHovered(true) : undefined}
          onBlur={web ? () => setHovered(false) : undefined}
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityHint={
            items.length && !web ? 'Long press for options' : undefined
          }
          accessibilityState={{ selected: active }}
          android_ripple={{ color: p.border }}
          className={
            android
              ? `mx-3 ${summary ? 'h-14' : 'h-12'} flex-row items-center gap-2 overflow-hidden rounded-full px-4 ${active ? 'bg-primary/15' : ''}`
              : `mx-2 flex-row items-center gap-2 rounded-[10px] px-4 py-2.5 active:bg-accent ${active ? 'bg-muted' : ''}`
          }
        >
          <View className="flex-1">
            <Text
              numberOfLines={1}
              className={`text-[15px] ${active ? 'text-foreground' : android ? 'text-foreground' : 'text-muted-foreground'}`}
            >
              {title}
            </Text>
            {summary ? (
              <Text numberOfLines={1} className="text-xs text-muted-foreground">
                {summary}
              </Text>
            ) : null}
          </View>
          {dot ? (
            <View className={`h-2 w-2 rounded-full ${DOT_CLASS[dot]}`} />
          ) : null}
          {trailing}
        </Pressable>
      )}
    </SpaceMenu>
  );
}

/** A space of a computer this device doesn't follow: opens like a sub-space. */
function ComputerItem({
  space,
  active,
  onPress,
}: {
  space: ComputerSpaceView;
  active: boolean;
  onPress: () => void;
}) {
  const p = usePalette();
  const dot = computerSpaceDot(space);
  const title = space.title || space.name || 'Untitled space';
  const label = [title, `on ${space.hostName}`, dot ? DOT_LABEL[dot] : null]
    .filter(Boolean)
    .join(', ');
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      testID={`computer-space-${space.space}`}
      android_ripple={{ color: p.border }}
      className={
        android
          ? `mx-3 h-14 flex-row items-center gap-2 overflow-hidden rounded-full px-4 ${active ? 'bg-primary/15' : ''}`
          : `mx-2 flex-row items-center gap-2 rounded-[10px] px-4 py-2.5 active:bg-accent ${active ? 'bg-muted' : ''}`
      }
    >
      <View className="flex-1">
        <Text
          numberOfLines={1}
          className={`text-[15px] ${active || android ? 'text-foreground' : 'text-muted-foreground'}`}
        >
          {title}
        </Text>
        <Text numberOfLines={1} className="text-xs text-muted-foreground">
          {space.hostName}
        </Text>
      </View>
      {dot ? (
        <View className={`h-2 w-2 rounded-full ${DOT_CLASS[dot]}`} />
      ) : null}
    </Pressable>
  );
}

type DrawerItem = SpaceView | ComputerSpaceView;
const followed = (x: DrawerItem): x is SpaceView => 'startedHere' in x;

function SearchField({
  value,
  onChangeText,
}: {
  value: string;
  onChangeText: (text: string) => void;
}) {
  const p = usePalette();
  return (
    <View
      className={
        android
          ? 'mx-3 mb-2 h-12 flex-row items-center gap-2 rounded-full bg-muted px-4'
          : 'mx-4 mb-2 h-9 flex-row items-center gap-1.5 rounded-[10px] bg-muted px-2'
      }
    >
      <SymbolImage name="search" size={android ? 22 : 16} color={p.muted} />
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder="Search spaces"
        placeholderTextColor={p.muted}
        accessibilityLabel="Search spaces"
        autoCorrect={false}
        autoCapitalize="none"
        returnKeyType="search"
        clearButtonMode="while-editing"
        className="flex-1 py-0 text-base text-foreground"
        style={{ outlineStyle: 'none' } as object}
      />
    </View>
  );
}

/**
 * "(JI) Jean · Personal  ⇅": the active account and its organization; a
 * tap opens the Accounts sheet (docs/mobile.md "Several accounts").
 */
function AccountLine({ onPress }: { onPress: () => void }) {
  const p = usePalette();
  const { session } = useAuthState();
  const accounts = useAccounts();
  const active = accounts.find((a) => a.active);
  const fetched = useOrganizationName();
  const org =
    fetched ??
    active?.orgs.find((o) => o.id === session?.organizationId)?.name ??
    null;
  const who = active?.label ?? session?.name ?? session?.email ?? 'Signed in';
  const others = accounts.length - 1;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Account: ${who}${org ? `, ${org}` : ''}. ${
        others > 0 ? `${others} more signed in. ` : ''
      }Accounts`}
      testID="drawer-account"
      android_ripple={{ color: p.border, borderless: false }}
      className="flex-1 flex-row items-center gap-2.5 overflow-hidden rounded-full p-1.5 active:opacity-60"
    >
      <View className="h-8 w-8 items-center justify-center rounded-full bg-muted">
        <Text className="text-[13px] font-semibold text-foreground">
          {active?.initials ?? initials(session?.name, session?.email)}
        </Text>
      </View>
      <Text numberOfLines={1} className="flex-1 text-sm text-foreground">
        {who}
        {org ? (
          <Text className="text-sm text-muted-foreground">{` · ${org}`}</Text>
        ) : null}
      </Text>
      <SymbolImage name="switch" size={16} color={p.muted} />
    </Pressable>
  );
}

export function DrawerContent({
  onNavigate,
  edges = ['top', 'bottom', 'left'],
}: {
  /** Opens a page from the drawer (a space, Devices, Settings). */
  onNavigate: (href: Href) => void;
  edges?: ('top' | 'bottom' | 'left')[];
}) {
  const p = usePalette();
  const path = usePathname();
  const { fleet } = useServices();
  const accountsSheet = useSheet('accounts');
  const spaces = useFleetState((s) => s.spaces);
  const computerSpaces = useFleetState((s) => s.computerSpaces);
  const refreshing = useFleetState((s) => s.refreshing);
  const archive = useArchive('row_menu');
  const load = useLoadState();
  const [query, setQuery] = useState('');
  const now = useMinute();
  const sections = useMemo(
    (): { title: string; data: DrawerItem[] }[] => [
      ...spaceSections(spaces, now, query),
      ...computerSections(computerSpaces, query),
    ],
    [spaces, computerSpaces, now, query],
  );
  const searching = query.trim() !== '';

  return (
    <SafeAreaView className="flex-1 bg-sidebar" edges={edges}>
      <View className={android ? 'px-7 pt-4 pb-3' : 'px-4 pt-2 pb-3'}>
        <Text
          accessibilityRole="header"
          className={
            android
              ? 'text-[22px] text-foreground'
              : 'text-[28px] font-bold text-foreground'
          }
        >
          Theodore Code
        </Text>
      </View>

      <SearchField value={query} onChangeText={setQuery} />

      <SectionList
        className="flex-1"
        sections={sections}
        keyExtractor={(s) =>
          followed(s) ? s.space : `${s.hostDevice}/${s.space}`
        }
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void fleet.refreshSpaces()}
            tintColor={p.muted}
          />
        }
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        stickySectionHeadersEnabled={false}
        contentContainerStyle={{ paddingBottom: 8 }}
        renderSectionHeader={({ section }) => (
          <Text
            accessibilityRole="header"
            className={
              android
                ? 'px-7 pt-5 pb-2 text-sm font-medium text-muted-foreground'
                : 'px-6 pt-5 pb-1.5 text-[13px] font-semibold text-muted-foreground'
            }
          >
            {section.title}
          </Text>
        )}
        renderItem={({ item }) => {
          if (!followed(item)) {
            const to = subSpaceHref(item.hostDevice, item.space);
            return (
              <ComputerItem
                space={item}
                active={path === to}
                onPress={() => onNavigate(to)}
              />
            );
          }
          const href = spaceHref(item.space);
          return (
            <SpaceItem
              space={item}
              active={path === href}
              onPress={() => onNavigate(href)}
              onMenu={(id) => void runSpaceMenuItem(id, item, { archive })}
            />
          );
        }}
        ListEmptyComponent={
          load === 'loading' && !searching ? (
            <View className="pt-3">
              <SkeletonRows />
            </View>
          ) : (
            <Text className="px-6 pt-6 text-[15px] text-muted-foreground">
              {searching
                ? `No space matches “${query.trim()}”`
                : load === 'unreachable'
                  ? 'Nothing loaded yet.'
                  : 'Spaces you start or follow show here.'}
            </Text>
          )
        }
        ListFooterComponent={
          load === 'unreachable' && !searching ? (
            <View
              accessible
              accessibilityRole="alert"
              accessibilityLiveRegion="polite"
              className="mx-6 mt-6 items-start gap-2"
            >
              <Text className="text-[13px] text-muted-foreground">
                {UNREACHABLE_TITLE}
              </Text>
              <Button
                label="Retry"
                variant="secondary"
                pill
                onPress={() => void fleet.start()}
                testID="drawer-retry"
              />
            </View>
          ) : undefined
        }
      />

      <View
        className="gap-1 border-t border-border pt-2 pb-2"
        style={{ borderTopWidth: StyleSheet.hairlineWidth }}
      >
        <NavItem
          label="Devices"
          icon="devices"
          active={path === '/devices'}
          onPress={() => onNavigate('/devices' as Href)}
          testID="drawer-devices"
        />
        <View className="mx-2 flex-row items-center gap-1 pr-1">
          <AccountLine
            // The sheet shows over the open drawer (iOS: a formSheet route,
            // Android and web: in place); a switch closes the drawer, a
            // dismissed sheet leaves it (docs/mobile.md "Several accounts").
            onPress={accountsSheet.open}
          />
          {accountsSheet.element}
          <Pressable
            onPress={() => onNavigate('/settings' as Href)}
            accessibilityRole="button"
            accessibilityLabel="Settings"
            testID="drawer-settings"
            hitSlop={6}
            android_ripple={{ color: p.border, borderless: true, radius: 24 }}
            className="h-10 w-10 items-center justify-center rounded-full active:bg-muted"
          >
            <SymbolImage name="settings" size={22} color={p.muted} />
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  );
}
