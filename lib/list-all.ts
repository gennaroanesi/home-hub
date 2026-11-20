// Walk `nextToken` until the full model is loaded. Amplify's `.list` caps
// a single request at 1 MB (AppSync DynamoDB resolver limit) regardless of
// the `limit` you pass, so anything over a few hundred rows silently
// truncates unless you paginate. We keep calling the model's .list with
// the previous page's nextToken until it comes back null.
//
// Typing notes: we deliberately accept `model: any` rather than trying
// to infer the row type from the Amplify model's `.list` signature.
// Amplify's row types are recursively self-referential (photo → albums
// → album-photos → photo → …) and routing them through a generic
// parameter `M` + `Awaited<ReturnType<M["list"]>>` blows out the TS
// "instantiation depth" budget the moment a caller wraps the result in
// anything more than a single useState. Callers annotate the return
// site with the row type (`Promise<Photo[]>` etc.), which keeps the
// checker happy without sacrificing downstream type safety.

// Pages of 1000 (still capped at 1 MB each): Amplify's default is 100, and
// a filtered list is a DynamoDB scan whose page limit counts rows *read*,
// not matched, so at 100 a filter over a 2,000-row table took 20 round
// trips one after another to find a handful of rows.
export const LIST_PAGE_SIZE = 1000;

export async function listAllPages<T = unknown>(
  model: any,
  options?: { filter?: any; limit?: number | null }
): Promise<T[]> {
  const collected: T[] = [];
  let token: string | null = null;
  do {
    const res = await model.list({
      ...(options ?? {}),
      limit: options?.limit === undefined ? LIST_PAGE_SIZE : options.limit,
      nextToken: token,
    });
    if (res?.data) collected.push(...(res.data as T[]));
    token = (res?.nextToken ?? null) as string | null;
  } while (token);
  return collected;
}
