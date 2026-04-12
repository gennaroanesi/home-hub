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

export async function listAllPages<T = unknown>(
  model: any,
  options?: { filter?: any; limit?: number | null }
): Promise<T[]> {
  const collected: T[] = [];
  let token: string | null = null;
  do {
    const res = await model.list({
      ...(options ?? {}),
      nextToken: token,
    });
    if (res?.data) collected.push(...(res.data as T[]));
    token = (res?.nextToken ?? null) as string | null;
  } while (token);
  return collected;
}
