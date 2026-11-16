/**
 * `/start` (old links, the desktop's "open on phone"): Home is where a
 * space starts now.
 */
import { Redirect, type Href } from 'expo-router';

export default function StartRedirect() {
  return <Redirect href={'/' as Href} />;
}
