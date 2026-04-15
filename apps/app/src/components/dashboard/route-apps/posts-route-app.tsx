import { createLazyDashboardRouteApp } from "../create-dashboard-route-app";
import type { PostsPageProps } from "../pages/posts-page";

export const PostsRouteApp =
	createLazyDashboardRouteApp<PostsPageProps>(() =>
		import("../pages/posts-page").then((module) => ({
			default: module.PostsPage,
		})),
	);
