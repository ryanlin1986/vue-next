import {
  reactive,
  readonly,
  toRaw,
  ReactiveFlags,
  Target,
  readonlyMap,
  reactiveMap,
  shallowReactiveMap,
  shallowReadonlyMap,
  isReadonly,
  isShallow
} from './reactive'
import { TrackOpTypes, TriggerOpTypes } from './operations'
import {
  track,
  trigger,
  ITERATE_KEY,
  pauseTracking,
  resetTracking
} from './effect'
import {
  isObject,
  hasOwn,
  isSymbol,
  hasChanged,
  isArray,
  isIntegerKey,
  extend,
  makeMap
} from '@vue/shared'
import { isRef } from './ref'
import { warn } from './warning'

const isNonTrackableKeys = /*#__PURE__*/ makeMap(`__proto__,__v_isRef,__isVue`)

const builtInSymbols = new Set(
  /*#__PURE__*/
  Object.getOwnPropertyNames(Symbol)
    // ios10.x Object.getOwnPropertyNames(Symbol) can enumerate 'arguments' and 'caller'
    // but accessing them on Symbol leads to TypeError because Symbol is a strict mode
    // function
    .filter(key => key !== 'arguments' && key !== 'caller')
    .map(key => (Symbol as any)[key])
    .filter(isSymbol)
)

const get = /*#__PURE__*/ createGetter()
const shallowGet = /*#__PURE__*/ createGetter(false, true)
const observableArrayGet = /*#__PURE__*/ createObservableArrayGetter()
const readonlyGet = /*#__PURE__*/ createGetter(true)
const shallowReadonlyGet = /*#__PURE__*/ createGetter(true, true)

const arrayInstrumentations = /*#__PURE__*/ createArrayInstrumentations()

function createArrayInstrumentations() {
  const instrumentations: Record<string, Function> = {}
    // instrument identity-sensitive Array methods to account for possible reactive
    // values
    // ; (['includes', 'indexOf', 'lastIndexOf'] as const).forEach(key => {
    //   instrumentations[key] = function (this: unknown[], ...args: unknown[]) {
    //     const arr = toRaw(this) as any
    //     for (let i = 0, l = this.length; i < l; i++) {
    //       track(arr, TrackOpTypes.GET, i + '')
    //     }
    //     // we run the method using the original args first (which may be reactive)
    //     const res = arr[key](...args)
    //     if (res === -1 || res === false) {
    //       // if that didn't work, run it again using raw values.
    //       return arr[key](...args.map(toRaw))
    //     } else {
    //       return res
    //     }
    //   }
    // })
    // instrument length-altering mutation methods to avoid length being tracked
    // which leads to infinite loops in some cases (#2137)
    ; (['push', 'pop', 'shift', 'unshift', 'splice'] as const).forEach(key => {
      instrumentations[key] = function (this: unknown[], ...args: unknown[]) {
        pauseTracking()
        let raw = <any>toRaw(this);
        let changes = <any>null;
        if (raw.subscriptions) {
          changes = [];

          if (key === 'push') {
            for (let i = 0; i < args.length; i++) {
              changes.push({
                status: "added",
                index: raw.length + i,
                value: args[i]
              });
            }
          }
          else if (key === 'shift') {
            changes.push({
              status: "deleted",
              index: 0,
              value: raw[0]
            });
          }
          else if (key === 'splice') {
            if (<number>args[1] > 0) {
              for (let i = 0; i < <number>args[1]; i++) {
                changes.push({
                  status: "deleted",
                  index: <number>args[0] + i,
                  value: raw[<number>args[0] + i]
                });
              }
            }
            for (let i = 2; i < args.length; i++) {
              changes.push({
                status: "added",
                index: <number>args[0] + i - 2,
                value: args[i]
              })
            }
          }
        }

        const res = (toRaw(this) as any)[key].apply(this, args)
        resetTracking()
        if (raw.subscriptions && changes?.length > 0) {
          if (raw.subscriptions instanceof Set) {
            let items = <any>Array.from(raw.subscriptions);
            for (let i = 0; i < items.length; i++) {
              if (typeof items[i] === "function")
                items[i](changes);
              else
                items[i].handler.call(items[i].context, changes);
            }
          }
          else {
            if (typeof raw.subscriptions === "function")
              raw.subscriptions(changes);
            else
              raw.subscriptions.handler.call(raw.subscriptions.context, changes);
          }
        }
        return res
      }
    })
  return instrumentations
}

function createGetter(isReadonly = false, shallow = false) {
  return function get(target: Target, key: string | symbol, receiver: object) {
    if (key === ReactiveFlags.IS_REACTIVE) {
      return !isReadonly
    } else if (key === ReactiveFlags.IS_READONLY) {
      return isReadonly
    } else if (key === ReactiveFlags.IS_SHALLOW) {
      return shallow
    } else if (
      key === ReactiveFlags.RAW &&
      receiver ===
      (isReadonly
        ? shallow
          ? shallowReadonlyMap
          : readonlyMap
        : shallow
          ? shallowReactiveMap
          : reactiveMap
      ).get(target)
    ) {
      return target
    }

    const targetIsArray = isArray(target)

    if (!isReadonly && targetIsArray && hasOwn(arrayInstrumentations, key)) {
      return Reflect.get(arrayInstrumentations, key, receiver)
    }

    const res = Reflect.get(target, key, receiver)

    // 数字无需处理索引访问
    if (targetIsArray && (<any>target)["__trackIndexAccess"] === undefined && shallow && isIntegerKey(key)) {
      return res;
    }
    if (isSymbol(key) ? builtInSymbols.has(key) : isNonTrackableKeys(key)) {
      return res
    }

    if (!isReadonly) {
      track(target, TrackOpTypes.GET, key)
    }

    if (shallow) {
      return res
    }

    if (isRef(res)) {
      // ref unwrapping - skip unwrap for Array + integer key.
      return targetIsArray && isIntegerKey(key) ? res : res.value
    }

    if (isObject(res)) {
      // Convert returned value into a proxy as well. we do the isObject check
      // here to avoid invalid value warning. Also need to lazy access readonly
      // and reactive here to avoid circular dependency.
      return isReadonly ? readonly(res) : reactive(res)
    }

    return res
  }
}

function createObservableArrayGetter() {
  return function get(target: Target, key: string | symbol, receiver: object) {
    if (key === ReactiveFlags.IS_REACTIVE) {
      return true
    } else if (key === ReactiveFlags.IS_READONLY) {
      return false
    } else if (key === ReactiveFlags.IS_SHALLOW) {
      return true
    } else if (
      key === ReactiveFlags.RAW
    ) {
      return target;
    }

    if (hasOwn(arrayInstrumentations, key)) {
      return Reflect.get(arrayInstrumentations, key, receiver)
    }

    const res = Reflect.get(target, key, receiver)

    // 数字无需处理索引访问
    if ((<any>target)["__trackIndexAccess"] === undefined && isIntegerKey(key)) {
      return res;
    }
    if (isSymbol(key) ? builtInSymbols.has(key) : isNonTrackableKeys(key)) {
      return res
    }
    track(target, TrackOpTypes.GET, key)
    return res
  }
}
const set = /*#__PURE__*/ createSetter()
const shallowSet = /*#__PURE__*/ createSetter(true)

function createSetter(shallow = false) {
  return function set(
    target: object,
    key: string | symbol,
    value: unknown,
    receiver: object
  ): boolean {
    let oldValue = (target as any)[key]
    if (isReadonly(oldValue) && isRef(oldValue) && !isRef(value)) {
      return false
    }
    if (!shallow) {
      if (!isShallow(value) && !isReadonly(value)) {
        oldValue = toRaw(oldValue)
        value = toRaw(value)
      }
      if (!isArray(target) && isRef(oldValue) && !isRef(value)) {
        oldValue.value = value
        return true
      }
    } else {
      // in shallow mode, objects are set as-is regardless of reactive or not
    }

    const hadKey =
      isArray(target) && isIntegerKey(key)
        ? Number(key) < target.length
        : hasOwn(target, key)
    const result = Reflect.set(target, key, value, receiver)
    // 数字无需处理索引访问
    if (isArray(target) && isIntegerKey(key) && (target as any)["__trackIndexAccess"] === undefined)
      return result;
    // don't trigger if target is something up in the prototype chain of original
    if (target === toRaw(receiver)) {
      if (!hadKey) {
        trigger(target, TriggerOpTypes.ADD, key, value)
      } else if (hasChanged(value, oldValue) || key === "length") {
        trigger(target, TriggerOpTypes.SET, key, value, oldValue)
      }
    }
    return result
  }
}

function deleteProperty(target: object, key: string | symbol): boolean {
  const hadKey = hasOwn(target, key)
  const oldValue = (target as any)[key]
  const result = Reflect.deleteProperty(target, key)
  if (result && hadKey) {
    trigger(target, TriggerOpTypes.DELETE, key, undefined, oldValue)
  }
  return result
}

function has(target: object, key: string | symbol): boolean {
  const result = Reflect.has(target, key)
  if (!isSymbol(key) || !builtInSymbols.has(key)) {
    track(target, TrackOpTypes.HAS, key)
  }
  return result
}

function ownKeys(target: object): (string | symbol)[] {
  track(target, TrackOpTypes.ITERATE, isArray(target) ? 'length' : ITERATE_KEY)
  return Reflect.ownKeys(target)
}

export const mutableHandlers: ProxyHandler<object> = {
  get,
  set,
  deleteProperty,
  has,
  ownKeys
}

export const readonlyHandlers: ProxyHandler<object> = {
  get: readonlyGet,
  set(target, key) {
    if (__DEV__) {
      warn(
        `Set operation on key "${String(key)}" failed: target is readonly.`,
        target
      )
    }
    return true
  },
  deleteProperty(target, key) {
    if (__DEV__) {
      warn(
        `Delete operation on key "${String(key)}" failed: target is readonly.`,
        target
      )
    }
    return true
  }
}

export const shallowReactiveHandlers = /*#__PURE__*/ extend(
  {},
  mutableHandlers,
  {
    get: shallowGet,
    set: shallowSet
  }
)

export const observableArrayHandlers = /*#__PURE__*/ extend(
  {},
  mutableHandlers,
  {
    get: observableArrayGet,
    set: shallowSet
  }
)

// Props handlers are special in the sense that it should not unwrap top-level
// refs (in order to allow refs to be explicitly passed down), but should
// retain the reactivity of the normal readonly object.
export const shallowReadonlyHandlers = /*#__PURE__*/ extend(
  {},
  readonlyHandlers,
  {
    get: shallowReadonlyGet
  }
)
