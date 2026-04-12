import { z } from "@hono/zod-openapi";

// --- Enums ---

export const GmbMediaCategory = z.enum([
	"COVER",
	"PROFILE",
	"LOGO",
	"EXTERIOR",
	"INTERIOR",
	"FOOD_AND_DRINK",
	"MENU",
	"PRODUCT",
	"AT_WORK",
	"COMMON_AREA",
	"ROOMS",
	"TEAMS",
	"ADDITIONAL",
]).describe("Google Business media category");

export const GmbPlaceActionType = z.enum([
	"APPOINTMENT",
	"ONLINE_APPOINTMENT",
	"DINING_RESERVATION",
	"FOOD_ORDERING",
	"FOOD_DELIVERY",
	"FOOD_TAKEOUT",
	"SHOP_ONLINE",
]).describe("Google Business place action type");

// --- Food Menus ---

export const GmbMenuItem = z.object({
	name: z.string().describe("Menu item name"),
	price: z.object({
		units: z.string().describe("Price amount (e.g. \"12\")"),
		currency: z.string().describe("ISO 4217 currency code (e.g. \"USD\")"),
	}).optional().describe("Item price"),
	description: z.string().optional().describe("Item description"),
	dietary: z.array(z.string()).optional().describe("Dietary info (e.g. VEGETARIAN, VEGAN)"),
	allergens: z.array(z.string()).optional().describe("Allergen info"),
});

export const GmbMenuSection = z.object({
	name: z.string().describe("Section name (e.g. \"Appetizers\")"),
	items: z.array(GmbMenuItem).describe("Menu items in this section"),
});

export const GmbFoodMenuBody = z.object({
	sections: z.array(GmbMenuSection).describe("Menu sections"),
	update_mask: z.string().optional().describe("Comma-separated fields to update"),
});

export const GmbFoodMenuResponse = z.object({
	data: z.any().describe("Google Business food menu data"),
});

// --- Location Details ---

export const GmbLocationDetailsQuery = z.object({
	read_mask: z.string().optional().describe("Comma-separated fields to read (e.g. \"regularHours,profile.description\")"),
});

export const GmbLocationDetailsBody = z.object({
	update_mask: z.string().describe("Comma-separated fields to update"),
	regularHours: z.any().optional().describe("Regular business hours"),
	specialHours: z.any().optional().describe("Special hours (holidays, etc.)"),
	profile: z.object({
		description: z.string().optional().describe("Business description"),
	}).optional().describe("Business profile"),
	websiteUri: z.string().url().optional().describe("Business website URL"),
	phoneNumbers: z.object({
		primaryPhone: z.string().optional().describe("Primary phone number"),
		additionalPhones: z.array(z.string()).optional().describe("Additional phone numbers"),
	}).optional().describe("Phone numbers"),
	categories: z.any().optional().describe("Business categories"),
	serviceItems: z.any().optional().describe("Service items"),
});

export const GmbLocationDetailsResponse = z.object({
	data: z.any().describe("Google Business location details"),
});

// --- Media/Photos ---

export const GmbUploadMediaBody = z.object({
	source_url: z.string().url().describe("Public URL of the image for Google to download"),
	category: GmbMediaCategory,
	description: z.string().optional().describe("Photo description"),
});

export const GmbMediaDeleteQuery = z.object({
	media_id: z.string().describe("Google media item ID to delete"),
});

export const GmbMediaResponse = z.object({
	data: z.any().describe("Google Business media data"),
});

// --- Attributes ---

export const GmbAttributeBody = z.object({
	attribute_mask: z.string().describe("Comma-separated attribute names to update"),
	attributes: z.array(z.object({
		name: z.string().describe("Attribute name"),
		values: z.array(z.any()).describe("Attribute values"),
	})).describe("Attributes to set"),
});

export const GmbAttributesResponse = z.object({
	data: z.any().describe("Google Business attributes data"),
});

// --- Place Actions ---

export const GmbPlaceActionBody = z.object({
	type: GmbPlaceActionType,
	url: z.string().url().describe("Action link URL"),
	name: z.string().optional().describe("Display name for the action"),
});

export const GmbPlaceActionDeleteQuery = z.object({
	action_id: z.string().describe("Place action link ID to delete"),
});

export const GmbPlaceActionsResponse = z.object({
	data: z.any().describe("Google Business place action links data"),
});
