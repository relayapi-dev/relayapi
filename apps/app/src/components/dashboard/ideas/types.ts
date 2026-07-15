export interface IdeaTag {
	id: string;
	name: string;
	color: string;
	workspace_id: string | null;
	created_at: string;
}

export interface IdeaMedia {
	id: string;
	media_id: string;
	url: string | null;
	thumbnail: string | null;
	type: "image" | "video" | "gif" | "document";
	alt: string | null;
	position: number;
	status:
		| "pending"
		| "uploading"
		| "upload_failed"
		| "ready"
		| "deleting"
		| "deletion_failed";
	original_available: boolean;
}

export interface Idea {
	id: string;
	title: string | null;
	content: string | null;
	group_id: string;
	position: number;
	assigned_to: string | null;
	converted_to_post_id: string | null;
	revision: number;
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
	revision: number;
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
