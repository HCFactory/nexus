import { useState, type Dispatch, type SetStateAction } from 'react';

/**
 * Local state that starts from a prop and resets whenever the prop changes,
 * while still letting the component edit it in between.
 *
 * Replaces `useEffect(() => setState(prop), [prop])`, which renders once with
 * the stale value and then again. Here the reset happens during render — the
 * pattern React recommends for "adjusting state when a prop changes":
 * https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
 *
 * `toState` maps the prop to the state value (e.g. a number to its display text).
 */
export function usePropState<P, S = P>(
  prop: P,
  toState: (prop: P) => S = (p) => p as unknown as S,
): [S, Dispatch<SetStateAction<S>>] {
  const [state, setState] = useState<S>(() => toState(prop));
  const [prevProp, setPrevProp] = useState<P>(prop);
  if (!Object.is(prop, prevProp)) {
    setPrevProp(prop);
    setState(toState(prop));
  }
  return [state, setState];
}
