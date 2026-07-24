/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {JSX} from 'react';


type SelectIntrinsicProps = JSX.IntrinsicElements['select'];
interface SelectProps extends SelectIntrinsicProps {
  label: string;
}

export default function Select({
  children,
  label,
  className,
  ...other
}: SelectProps): JSX.Element {
  return (
    <div className="Input__wrapper flex flex-row items-center mb-[10px]">
      <label style={{marginTop: '-1em'}} className="Input__label flex flex-1 text-nim-muted">
        {label}
      </label>
      <select
        {...other}
        className={className || 'select min-w-[160px] max-w-[290px] border border-nim rounded-[0.25em] py-[0.25em] px-[0.5em] text-base cursor-pointer leading-[1.4] bg-nim-secondary text-nim appearance-none z-[1] outline-none font-inherit dark:[color-scheme:dark]'}>
        {children}
      </select>
    </div>
  );
}
