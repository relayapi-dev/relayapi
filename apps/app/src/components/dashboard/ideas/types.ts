export interface IdeaTag {
	id: string;
	name: string;
	color: string;
	workspace_id: string | null;
	created_at: string;
}

export interface IdeaMedia {
	id: string;
	url: string;
	type: "image" | "video" | "gif" | "document";
	alt: string | null;
	position: number;
}

export interface Idea {
	id: string;
	title: string | null;
	content: string | null;
	group_id: string;
	position: number;
	assigned_to: string | null;
	converted_to_post_id: string | null;
	tags: IdeaTag[];
	media: IdeaMedia[];
	workspace_id: string | null;
	created_at: string;
	updated_at: string;
}

export interface IdeaGroup {
	id: string;
	name: string;
	position: number;
	color: string | null;
	is_default: boolean;
	workspace_id: string | null;
	created_at: string;
	updated_at: string;
}

export interface IdeaComment {
	id: string;
	author_id: string;
	author: {
		id: string;
		name: string | null;
		image: string | null;
	} | null;
	content: string;
	parent_id: string | null;
	created_at: string;
	updated_at: string;
}
