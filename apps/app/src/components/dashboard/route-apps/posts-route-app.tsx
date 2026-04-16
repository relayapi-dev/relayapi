import { createDashboardRouteApp } from "../create-dashboard-route-app";
import { PostsPage, type PostsPageProps } from "../pages/posts-page";

export const PostsRouteApp =
	createDashboardRouteApp<PostsPageProps>(PostsPage);
