import { DebuggerOptions, ReactiveEffect } from './effect'
import { Ref, trackRefValue, triggerRefValue } from './ref'
import { isFunction, NOOP } from '@vue/shared'
import { ReactiveFlags, toRaw } from './reactive'
import { Dep } from './dep'

declare const ComputedRefSymbol: unique symbol

export interface ComputedRef<T = any> extends WritableComputedRef<T> {
  readonly value: T
  [ComputedRefSymbol]: true
}

export interface WritableComputedRef<T> extends Ref<T> {
  readonly effect: ReactiveEffect<T>
}

export type ComputedGetter<T> = (...args: any[]) => T
export type ComputedSetter<T> = (v: T) => void

export interface WritableComputedOptions<T> {
  get: ComputedGetter<T>
  set: ComputedSetter<T>
}

export class ComputedRefImpl<T> {
  public dep?: Dep = undefined

  private _value!: T
  private _subscriptions: Array<Function> | Function = <any>undefined

  public readonly effect: ReactiveEffect<T>

  public readonly __v_isRef = true
  public readonly [ReactiveFlags.IS_READONLY]: boolean = false

  public _dirty = true
  public _cacheable: boolean

  constructor(
    getter: ComputedGetter<T>,
    private readonly _setter: ComputedSetter<T>,
    isReadonly: boolean,
    isSSR: boolean
  ) {
    this.effect = new ReactiveEffect(getter, () => {
      if (!this._dirty) {
        this._dirty = true
        triggerRefValue(this)
        if (this._subscriptions) {
          let oldVal = this._value;
          let newValue = this.value;
          if (oldVal != newValue&& this._subscriptions) {
            if (this._subscriptions instanceof Array) {
              let subscriptions = this._subscriptions.slice();
              for (let i = 0; i < subscriptions.length; i++) {
                subscriptions[i](newValue, oldVal);
              }
            }
            else {
              this._subscriptions(newValue, oldVal);
            }
          }
        }
      }
    })
    this.effect.computed = this
    this.effect.active = this._cacheable = !isSSR
    this[ReactiveFlags.IS_READONLY] = isReadonly
  }

  get value() {
    // the computed ref may get wrapped by other proxies e.g. readonly() #3376
    const self = toRaw(this)
    trackRefValue(self)
    if (self._dirty || !self._cacheable) {
      self._dirty = false
      let value = self.effect.run()!;
      if (value instanceof Promise) {
        value.then(value => {
          if (self._value !== value) {
            let oldVal = self._value;
            self._value = value;
            triggerRefValue(this);
            if (this._subscriptions) {
              if (this._subscriptions instanceof Array) {
                let subscriptions = this._subscriptions.slice();
                for (let i = 0; i < subscriptions.length; i++) {
                  subscriptions[i](value, oldVal);
                }
              }
              else {
                this._subscriptions(value, oldVal);
              }
            }
          }
        });
      }
      else {
        if (self._value !== value) {
          let oldVal = self._value;
          self._value = value;
          triggerRefValue(this);
          if (this._subscriptions) {
            if (this._subscriptions instanceof Array) {
              let subscriptions = this._subscriptions.slice();
              for (let i = 0; i < subscriptions.length; i++) {
                subscriptions[i](value, oldVal);
              }
            }
            else {
              this._subscriptions(value, oldVal);
            }
          }
        }
      }
    }
    return self._value
  }

  set value(newValue: T) {
    this._setter(newValue)
  }


  subscribe(changed: Function, context: any) {
    (this.value as any)?.toString();
    if (context)
      changed = changed.bind(context);
    if (!this._subscriptions) {
      this.value;
      this._subscriptions = changed;
    }
    else if (this._subscriptions instanceof Array) {
      this._subscriptions.push(changed);
    }
    else {
      this._subscriptions = [this._subscriptions, changed];
    }
    return {
      dispose: () => {
        if (this._subscriptions === changed)
          this._subscriptions = <any>null;
        else if (this._subscriptions instanceof Array)
          this._subscriptions.splice(this._subscriptions.indexOf(changed), 1);
      }
    }
  }

  dispose() {
    this.effect.stop();
  }
}

export function computed<T>(
  getter: ComputedGetter<T>,
  debugOptions?: DebuggerOptions
): ComputedRef<T>
export function computed<T>(
  options: WritableComputedOptions<T>,
  debugOptions?: DebuggerOptions
): WritableComputedRef<T>
export function computed<T>(
  getterOrOptions: ComputedGetter<T> | WritableComputedOptions<T>,
  debugOptions?: DebuggerOptions,
  isSSR = false
) {
  let getter: ComputedGetter<T>
  let setter: ComputedSetter<T>

  const onlyGetter = isFunction(getterOrOptions)
  if (onlyGetter) {
    getter = getterOrOptions
    setter = __DEV__
      ? () => {
        console.warn('Write operation failed: computed value is readonly')
      }
      : NOOP
  } else {
    getter = getterOrOptions.get
    setter = getterOrOptions.set
  }

  const cRef = new ComputedRefImpl(getter, setter, onlyGetter || !setter, isSSR)

  if (__DEV__ && debugOptions && !isSSR) {
    cRef.effect.onTrack = debugOptions.onTrack
    cRef.effect.onTrigger = debugOptions.onTrigger
  }

  return cRef as any
}
